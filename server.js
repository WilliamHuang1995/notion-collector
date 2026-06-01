import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Client } from '@notionhq/client';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3002;

const ALLOWED_DOMAIN = 'fazzfinancial.com';

// Notion IDs (configurable via .env)
const RFC_DATABASE_ID = process.env.RFC_DATABASE_ID;
const SHARED_NOTES_PAGE_ID = process.env.SHARED_NOTES_PAGE_ID;
const INCIDENTS_DATABASE_ID = process.env.INCIDENTS_DATABASE_ID;

// --- OAuth Setup ---

app.use(session({
  secret: process.env.SESSION_SECRET || 'notion-collector-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 days
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || `http://localhost:${PORT}/auth/google/callback`,
  }, (accessToken, refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value || '';
    if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) {
      return done(null, false, { message: `Only @${ALLOWED_DOMAIN} accounts allowed` });
    }
    done(null, { id: profile.id, name: profile.displayName, email, avatar: profile.photos?.[0]?.value });
  }));
}

// Auth routes
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], hd: ALLOWED_DOMAIN }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/auth/denied' }),
  (req, res) => res.redirect('/')
);

app.get('/auth/denied', (req, res) => {
  res.status(403).send(`<h2>Access Denied</h2><p>Only @${ALLOWED_DOMAIN} accounts can access this tool.</p><a href="/auth/google">Try again</a>`);
});

app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

app.get('/auth/me', (req, res) => {
  if (req.isAuthenticated()) return res.json(req.user);
  res.status(401).json({ error: 'Not authenticated' });
});

// Auth guard — skip if OAuth not configured (local dev)
function requireAuth(req, res, next) {
  if (!process.env.GOOGLE_CLIENT_ID) return next(); // No OAuth configured, allow all (local dev)
  if (req.isAuthenticated()) return next();
  if (req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'Not authenticated. Visit /auth/google to sign in.' });
  }
  res.redirect('/auth/google');
}

// Middleware to create Notion client from token
function notionClient(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || process.env.NOTION_TOKEN;
  if (!token || token === 'secret_xxx') {
    return res.status(401).json({ error: 'Notion token required. Set NOTION_TOKEN in .env or pass Authorization header.' });
  }
  req.notion = new Client({ auth: token });
  next();
}

// Cache for workspace users
let usersCache = null;
let usersCacheTime = 0;
const USERS_CACHE_TTL = 1000 * 60 * 60; // 1 hour

async function getWorkspaceUsers(notion) {
  if (usersCache && Date.now() - usersCacheTime < USERS_CACHE_TTL) return usersCache;

  const users = [];
  let cursor;
  do {
    const response = await notion.users.list({ page_size: 100, start_cursor: cursor });
    users.push(...response.results.filter(u => u.type === 'person'));
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);

  usersCache = users.map(u => ({ id: u.id, name: u.name, email: u.person?.email || null, avatar: u.avatar_url }));
  usersCacheTime = Date.now();
  return usersCache;
}

// Resolve a display name to a Notion user ID
async function resolveUserIds(notion, name) {
  const users = await getWorkspaceUsers(notion);
  const nameTokens = name.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  return users
    .filter(u => {
      const n = u.name?.toLowerCase() || '';
      return n.includes(name.toLowerCase()) || nameTokens.every(t => n.includes(t));
    })
    .map(u => u.id);
}

// Cache for RFC comments — persisted to .cache/comments.json
const CACHE_DIR = join(__dirname, '.cache');
const COMMENTS_CACHE_FILE = join(CACHE_DIR, 'comments.json');
let commentsCache = null; // Map<userId, [{ rfcId, rfcTitle, rfcUrl, comment, createdAt }]>
let commentsCacheBuilding = false;
let commentsCachePromise = null;

function loadCacheFromDisk() {
  try {
    if (existsSync(COMMENTS_CACHE_FILE)) {
      const data = JSON.parse(readFileSync(COMMENTS_CACHE_FILE, 'utf-8'));
      commentsCache = new Map(Object.entries(data));
      console.log(`Comments cache loaded from disk: ${[...commentsCache.values()].reduce((s, c) => s + c.length, 0)} comments`);
      return true;
    }
  } catch { /* corrupt file, rebuild */ }
  return false;
}

function saveCacheToDisk(cache) {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    const obj = Object.fromEntries(cache);
    writeFileSync(COMMENTS_CACHE_FILE, JSON.stringify(obj));
  } catch (err) { console.error('Failed to save comments cache:', err.message); }
}

// Try loading from disk on startup
loadCacheFromDisk();

async function getCommentsCache(notion, cutoff) {
  if (commentsCache) return commentsCache;
  if (commentsCacheBuilding) return commentsCachePromise;

  commentsCacheBuilding = true;
  commentsCachePromise = buildCommentsCache(notion, cutoff);
  commentsCache = await commentsCachePromise;
  saveCacheToDisk(commentsCache);
  commentsCacheBuilding = false;
  return commentsCache;
}

async function buildCommentsCache(notion, cutoff) {
  console.log('Building RFC comments cache...');
  const cache = new Map(); // userId -> comments[]

  // Fetch all RFCs in window
  let cursor;
  const rfcPages = [];
  do {
    const response = await notion.databases.query({
      database_id: RFC_DATABASE_ID,
      start_cursor: cursor,
      filter: { property: 'Created at', created_time: { on_or_after: cutoff.toISOString() } },
      sorts: [{ property: 'Created at', direction: 'descending' }],
    });
    rfcPages.push(...response.results);
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);

  // Fetch comments for each RFC (batched to avoid rate limits)
  for (let i = 0; i < rfcPages.length; i += 5) {
    const batch = rfcPages.slice(i, i + 5);
    await Promise.all(batch.map(async (page) => {
      try {
        const rfcTitle = page.properties['Name']?.title?.map(t => t.plain_text).join('') || 'Untitled';
        const rfcUrl = page.url;
        const rfcId = page.id;

        let commentCursor;
        do {
          const res = await notion.comments.list({ block_id: rfcId, start_cursor: commentCursor });
          for (const comment of res.results) {
            const userId = comment.created_by?.id;
            const userName = comment.created_by?.name || '';
            if (!userId) continue;

            const text = comment.rich_text?.map(t => t.plain_text).join('') || '';
            const entry = { rfcId, rfcTitle, rfcUrl, comment: text, createdAt: comment.created_time, userName };

            if (!cache.has(userId)) cache.set(userId, []);
            cache.get(userId).push(entry);
          }
          commentCursor = res.has_more ? res.next_cursor : null;
        } while (commentCursor);
      } catch { /* skip inaccessible pages */ }
    }));
  }

  console.log(`Comments cache built: ${rfcPages.length} RFCs, ${[...cache.values()].reduce((s, c) => s + c.length, 0)} comments`);
  return cache;
}

function getCommentsForUser(cache, userIds) {
  const comments = [];
  for (const id of userIds) {
    if (cache.has(id)) comments.push(...cache.get(id));
  }
  return comments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// GET /api/users — returns all workspace users for autocomplete
app.get('/api/users', requireAuth, notionClient, async (req, res) => {
  try {
    const users = await getWorkspaceUsers(req.notion);
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats?name=William&months=6
app.get('/api/stats', requireAuth, notionClient, async (req, res) => {
  try {
    const { name, months: monthsStr = '6' } = req.query;
    if (!name) return res.status(400).json({ error: 'name query param required' });

    const months = Math.max(1, Math.min(24, parseInt(monthsStr, 10) || 6));
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);

    const userIds = await resolveUserIds(req.notion, name);

    const [rfcData, sharedNotesData, incidentData, commentsData] = await Promise.all([
      getRFCStats(req.notion, name, userIds, cutoff),
      getSharedNotesStats(req.notion, name, cutoff),
      getIncidentStats(req.notion, name, userIds, cutoff),
      getCommentsCache(req.notion, cutoff).then(cache => {
        const comments = getCommentsForUser(cache, userIds);
        // Group by RFC
        const byRfc = new Map();
        for (const c of comments) {
          if (!byRfc.has(c.rfcId)) byRfc.set(c.rfcId, { rfcTitle: c.rfcTitle, rfcUrl: c.rfcUrl, comments: [] });
          byRfc.get(c.rfcId).comments.push({ comment: c.comment, createdAt: c.createdAt });
        }
        return {
          total: comments.length,
          rfcsCommented: byRfc.size,
          byRfc: [...byRfc.values()],
        };
      }),
    ]);

    res.json({
      engineer: name,
      window: `${months} months`,
      cutoff: cutoff.toISOString().split('T')[0],
      rfc: rfcData,
      sharedNotes: sharedNotesData,
      incidents: incidentData,
      comments: commentsData,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rfc-detail?name=William&months=6
app.get('/api/rfc-detail', requireAuth, notionClient, async (req, res) => {
  try {
    const { name, months: monthsStr = '6' } = req.query;
    if (!name) return res.status(400).json({ error: 'name query param required' });

    const months = Math.max(1, Math.min(24, parseInt(monthsStr, 10) || 6));
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);

    const userIds = await resolveUserIds(req.notion, name);
    const rfcs = await queryRFCs(req.notion, name, userIds, cutoff);
    res.json({ engineer: name, rfcs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- RFC Logic ---

async function queryRFCs(notion, name, userIds, cutoff) {
  const results = [];
  let cursor;

  do {
    const response = await notion.databases.query({
      database_id: RFC_DATABASE_ID,
      start_cursor: cursor,
      filter: {
        and: [
          {
            property: 'Created at',
            created_time: { on_or_after: cutoff.toISOString() },
          },
        ],
      },
      sorts: [{ property: 'Created at', direction: 'descending' }],
    });

    for (const page of response.results) {
      const writerId = page.properties['Writer']?.created_by?.id || '';
      const writerName = page.properties['Writer']?.created_by?.name || '';
      // Match by ID first, fall back to name
      if (userIds.includes(writerId) || writerName.toLowerCase().includes(name.toLowerCase())) {
        results.push(page);
      }
    }

    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);

  return results.map(page => ({
    id: page.id,
    title: page.properties['Name']?.title?.map(t => t.plain_text).join('') || 'Untitled',
    status: page.properties['Status']?.status?.name || 'Unknown',
    createdAt: page.properties['Created at']?.created_time || page.created_time,
    reviewedOn: page.properties['Reviewed on']?.date?.start || null,
    lastEdited: page.properties['Last edited time']?.last_edited_time || null,
    aiSummary: page.properties['AI summary']?.rich_text?.map(t => t.plain_text).join('') || null,
    url: page.url,
  }));
}

async function getRFCStats(notion, name, userIds, cutoff) {
  const rfcs = await queryRFCs(notion, name, userIds, cutoff);

  const statusBreakdown = {};
  let totalDaysToReview = 0;
  let reviewedCount = 0;

  for (const rfc of rfcs) {
    statusBreakdown[rfc.status] = (statusBreakdown[rfc.status] || 0) + 1;

    if (rfc.reviewedOn && rfc.createdAt) {
      const created = new Date(rfc.createdAt);
      const reviewed = new Date(rfc.reviewedOn);
      const days = (reviewed - created) / (1000 * 60 * 60 * 24);
      if (days >= 0) {
        totalDaysToReview += days;
        reviewedCount++;
      }
    }
  }

  return {
    total: rfcs.length,
    statusBreakdown,
    avgDaysToReview: reviewedCount > 0 ? Math.round(totalDaysToReview / reviewedCount) : null,
    reviewed: reviewedCount,
    titles: rfcs.map(r => ({ title: r.title, status: r.status, url: r.url })),
  };
}

// --- Shared Notes Logic ---

async function getSharedNotesStats(notion, name, cutoff) {
  // Get children of the shared notes page
  const topChildren = await getAllChildren(notion, SHARED_NOTES_PAGE_ID);

  // The entries are nested inside toggle headings, so we need to look inside them
  let allEntries = [];
  for (const block of topChildren) {
    if (block.has_children) {
      const nested = await getAllChildren(notion, block.id);
      allEntries.push(...nested);
    }
    allEntries.push(block);
  }

  // Find matching child page or database
  // Strategy: try full name, then all tokens, then token-based with verification
  const nameTokens = name.toLowerCase().split(/\s+/).filter(t => t.length > 2);

  let match = allEntries.find(block => {
    const title = getBlockTitle(block).toLowerCase().trim();
    if (!title) return false;
    return title.includes(name.toLowerCase());
  });

  if (!match) {
    match = allEntries.find(block => {
      const title = getBlockTitle(block).toLowerCase().trim();
      if (!title) return false;
      return nameTokens.every(token => title.includes(token));
    });
  }

  if (!match && nameTokens.length > 0) {
    // Fall back to token matching against "Shared Notes" entries
    const candidates = allEntries.filter(block => {
      const title = getBlockTitle(block).toLowerCase().trim();
      return title && title.includes('shared note') && nameTokens.some(token => title.includes(token));
    });

    if (candidates.length > 0) {
      let bestCandidate = null;
      let bestScore = -1;

      for (const candidate of candidates) {
        const title = getBlockTitle(candidate).toLowerCase().trim();

        // Extract the name part from title (before "'s shared note" or "shared note")
        const nameInTitle = title.replace(/[''\u2019]s\s+shared\s+note.*$/i, '').replace(/\s+shared\s+note.*$/i, '').trim();
        const titleNameTokens = nameInTitle.split(/\s+/).filter(t => t.length > 2);

        // Reject if the title name contains tokens NOT in our search name
        const hasConflict = titleNameTokens.some(t => !nameTokens.includes(t) && t.length > 2);
        if (hasConflict) continue;

        const titleScore = nameTokens.filter(token => title.includes(token)).length;
        const verification = await verifySharedNotesOwner(notion, candidate, name, nameTokens);

        if (verification === 'rejected') continue;
        const score = titleScore + (verification === 'confirmed' ? 100 : 0);
        if (score > bestScore) {
          bestScore = score;
          bestCandidate = candidate;
        }
      }

      match = bestCandidate;
    }
  }

  if (!match) {
    return { found: false, message: `No shared notes found for "${name}"` };
  }

  const title = getBlockTitle(match);
  const id = match.id;
  const type = match.type;

  // If it's a child_database, query it for page count within window
  if (type === 'child_database') {
    const pages = await queryDatabase(notion, id, cutoff);
    return {
      found: true,
      title,
      type: 'database',
      totalEntries: pages.length,
      lastUpdated: pages.length > 0 ? pages[0].last_edited_time : null,
      recentEntries: pages.map(p => ({
        title: p.properties?.Name?.title?.map(t => t.plain_text).join('') ||
               p.properties?.title?.title?.map(t => t.plain_text).join('') ||
               getFirstTitleProperty(p) || 'Untitled',
        lastEdited: p.last_edited_time,
        createdAt: p.created_time,
        url: p.url,
      })),
    };
  }

  // If it's a child_page, it might contain sub-pages or a database with entries
  if (type === 'child_page') {
    const subChildren = await getAllChildren(notion, id);
    const subPages = subChildren.filter(b => b.type === 'child_page' || b.type === 'child_database');

    // If there's a child_database inside, query it for entries
    const childDbs = subChildren.filter(b => b.type === 'child_database');
    if (childDbs.length > 0) {
      let allDbEntries = [];
      let inaccessible = 0;
      for (const db of childDbs) {
        try {
          const entries = await queryDatabase(notion, db.id, cutoff);
          allDbEntries.push(...entries);
        } catch {
          inaccessible++;
        }
      }

      const directPages = subChildren.filter(b => b.type === 'child_page');
      const pageDetails = [];
      for (let i = 0; i < directPages.length; i += 10) {
        const batch = directPages.slice(i, i + 10);
        const details = await Promise.all(batch.map(async (block) => {
          try { return await notion.pages.retrieve({ page_id: block.id }); }
          catch { inaccessible++; return null; }
        }));
        pageDetails.push(...details.filter(Boolean));
      }
      const filteredPages = pageDetails.filter(p => new Date(p.last_edited_time) >= cutoff);

      const combined = [
        ...allDbEntries.map(p => ({
          title: getFirstTitleProperty(p) || 'Untitled',
          lastEdited: p.last_edited_time,
          createdAt: p.created_time,
          url: p.url,
        })),
        ...filteredPages.map(p => ({
          title: getFirstTitleProperty(p) || 'Untitled',
          lastEdited: p.last_edited_time,
          createdAt: p.created_time,
          url: p.url,
        })),
      ].sort((a, b) => new Date(b.lastEdited) - new Date(a.lastEdited));

      return {
        found: true,
        title,
        type: 'page',
        totalEntries: combined.length,
        totalChildren: subPages.length,
        inaccessible,
        lastUpdated: combined.length > 0 ? combined[0].lastEdited : null,
        recentEntries: combined,
      };
    }

    // No child databases — just fetch page metadata directly
    const pageDetails = [];
    let inaccessible = 0;
    for (let i = 0; i < subPages.length; i += 10) {
      const batch = subPages.slice(i, i + 10);
      const details = await Promise.all(batch.map(async (block) => {
        try {
          if (block.type === 'child_database') {
            const db = await notion.databases.retrieve({ database_id: block.id });
            return { ...db, url: db.url, last_edited_time: db.last_edited_time, created_time: db.created_time, properties: {} };
          }
          return await notion.pages.retrieve({ page_id: block.id });
        } catch {
          inaccessible++;
          return null;
        }
      }));
      pageDetails.push(...details.filter(Boolean));
    }

    const filtered = pageDetails.filter(p => new Date(p.last_edited_time) >= cutoff);
    filtered.sort((a, b) => new Date(b.last_edited_time) - new Date(a.last_edited_time));

    return {
      found: true,
      title,
      type: 'page',
      totalEntries: filtered.length,
      totalChildren: subPages.length,
      inaccessible,
      lastUpdated: filtered.length > 0 ? filtered[0].last_edited_time : null,
      recentEntries: filtered.map(p => ({
        title: getFirstTitleProperty(p) || p.title?.map(t => t.plain_text).join('') || 'Untitled',
        lastEdited: p.last_edited_time,
        createdAt: p.created_time,
        url: p.url,
      })),
    };
  }

  return { found: true, title, type, totalEntries: 0 };
}

function getBlockTitle(block) {
  if (block.type === 'child_page') return block.child_page?.title || '';
  if (block.type === 'child_database') return block.child_database?.title || '';
  return '';
}

async function verifySharedNotesOwner(notion, block, name, nameTokens) {
  // Returns: 'confirmed' | 'rejected' | 'unknown'
  try {
    const id = block.id;
    let creator = '';
    if (block.type === 'child_database') {
      const response = await notion.databases.query({ database_id: id, page_size: 1 });
      if (response.results.length > 0) {
        creator = response.results[0].created_by?.name?.toLowerCase() || '';
      }
    } else if (block.type === 'child_page') {
      const page = await notion.pages.retrieve({ page_id: id });
      creator = page.created_by?.name?.toLowerCase() || '';
    }

    if (!creator) return 'unknown';
    if (creator.includes(name.toLowerCase()) || nameTokens.every(t => creator.includes(t))) return 'confirmed';
    return 'rejected';
  } catch {
    return 'unknown';
  }
}

function getFirstTitleProperty(page) {
  for (const [, prop] of Object.entries(page.properties || {})) {
    if (prop.type === 'title') {
      return prop.title?.map(t => t.plain_text).join('') || null;
    }
  }
  return null;
}

async function getAllChildren(notion, blockId) {
  const children = [];
  let cursor;

  do {
    const response = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    children.push(...response.results);
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);

  return children;
}

async function queryDatabase(notion, databaseId, cutoff) {
  const pages = [];
  let cursor;

  do {
    const response = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      filter: cutoff ? {
        timestamp: 'last_edited_time',
        last_edited_time: { on_or_after: cutoff.toISOString() },
      } : undefined,
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
    });
    pages.push(...response.results);
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);

  return pages;
}

// --- Incidents Logic ---

const PERSON_FIELDS = ['Responsible', 'IMOC', 'Comms Lead', 'EM in charge', 'Created by'];

async function getIncidentStats(notion, name, userIds, cutoff) {
  const results = [];
  let cursor;
  const nameTokens = name.toLowerCase().split(/\s+/).filter(t => t.length > 2);

  do {
    const response = await notion.databases.query({
      database_id: INCIDENTS_DATABASE_ID,
      start_cursor: cursor,
      filter: {
        timestamp: 'created_time',
        created_time: { on_or_after: cutoff.toISOString() },
      },
      sorts: [{ property: 'Created At', direction: 'descending' }],
    });

    for (const page of response.results) {
      const roles = getPersonRoles(page, name, nameTokens, userIds);
      if (roles.length > 0) {
        results.push({
          title: getFirstTitleProperty(page) || 'Untitled',
          roles,
          startTime: page.properties['Start Time']?.date?.start || null,
          endTime: page.properties['End Time']?.date?.start || null,
          summary: page.properties['Short Summary']?.rich_text?.map(t => t.plain_text).join('') || null,
          url: page.url,
        });
      }
    }

    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);

  const roleBreakdown = {};
  for (const incident of results) {
    for (const role of incident.roles) {
      roleBreakdown[role] = (roleBreakdown[role] || 0) + 1;
    }
  }

  return {
    total: results.length,
    roleBreakdown,
    incidents: results,
  };
}

function getPersonRoles(page, name, nameTokens, userIds) {
  const roles = [];
  for (const field of PERSON_FIELDS) {
    const prop = page.properties[field];
    if (!prop) continue;

    let personIds = [];
    let personName = '';

    if (prop.type === 'people') {
      personIds = prop.people?.map(p => p.id) || [];
      personName = prop.people?.map(p => p.name || '').join(' ') || '';
    } else if (prop.type === 'created_by') {
      personIds = [prop.created_by?.id].filter(Boolean);
      personName = prop.created_by?.name || '';
    } else if (prop.type === 'person') {
      personIds = prop.people?.map(p => p.id) || [];
      personName = prop.people?.map(p => p.name || '').join(' ') || '';
    }

    // Match by ID first (reliable), fall back to name matching
    const idMatch = personIds.some(id => userIds.includes(id));
    if (idMatch) {
      roles.push(field);
      continue;
    }

    const lower = personName.toLowerCase();
    if (lower && (lower.includes(name.toLowerCase()) || nameTokens.every(t => lower.includes(t)))) {
      roles.push(field);
    }
  }
  return roles;
}

// Serve frontend (auth-gated)
app.use(requireAuth, express.static(join(__dirname, 'frontend')));

app.listen(PORT, () => {
  console.log(`notion-collector running on http://localhost:${PORT}`);
});
