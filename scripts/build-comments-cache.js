import 'dotenv/config';
import { Client } from '@notionhq/client';
import { writeFileSync, mkdirSync, existsSync } from 'fs';

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const RFC_DATABASE_ID = process.env.RFC_DATABASE_ID;

const usersResp = await notion.users.list({ page_size: 100 });
const userNameMap = new Map(usersResp.results.filter(u => u.type === 'person').map(u => [u.id, u.name]));

const cutoff = new Date();
cutoff.setMonth(cutoff.getMonth() - 6);
const rfcPages = [];
let cursor;
do {
  const r = await notion.databases.query({ database_id: RFC_DATABASE_ID, start_cursor: cursor, filter: { property: 'Created at', created_time: { on_or_after: cutoff.toISOString() } } });
  rfcPages.push(...r.results);
  cursor = r.has_more ? r.next_cursor : null;
} while (cursor);
console.log('RFCs:', rfcPages.length);

// Page-level comments only (inline comments require per-block polling which is too slow)
const cache = {};
let total = 0;

for (let i = 0; i < rfcPages.length; i += 5) {
  const batch = rfcPages.slice(i, i + 5);
  await Promise.all(batch.map(async (page) => {
    const rfcTitle = page.properties['Name']?.title?.map(t => t.plain_text).join('') || 'Untitled';
    const rfcUrl = page.url;
    const rfcId = page.id;
    try {
      let cc;
      do {
        const res = await notion.comments.list({ block_id: rfcId, start_cursor: cc });
        for (const c of res.results) {
          const userId = c.created_by?.id;
          if (!userId) continue;
          const text = c.rich_text?.map(t => t.plain_text).join('') || '';
          if (!cache[userId]) cache[userId] = [];
          cache[userId].push({ rfcId, rfcTitle, rfcUrl, comment: text, createdAt: c.created_time, userName: userNameMap.get(userId) || '' });
          total++;
        }
        cc = res.has_more ? res.next_cursor : null;
      } while (cc);
    } catch {}
  }));
  if ((i + 5) % 20 < 5) console.log(`  processed ${Math.min(i + 5, rfcPages.length)}/${rfcPages.length} | comments: ${total}`);
}

if (!existsSync('.cache')) mkdirSync('.cache');
writeFileSync('.cache/comments.json', JSON.stringify(cache));
console.log(`Done: ${total} comments from ${rfcPages.length} RFCs`);
