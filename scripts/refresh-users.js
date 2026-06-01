import 'dotenv/config';
import { Client } from '@notionhq/client';
import { writeFileSync } from 'fs';

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const users = [];
let cursor;

do {
  const response = await notion.users.list({ page_size: 100, start_cursor: cursor });
  users.push(...response.results.filter(u => u.type === 'person'));
  cursor = response.has_more ? response.next_cursor : null;
} while (cursor);

const data = users.map(u => ({
  id: u.id,
  name: u.name,
  email: u.person?.email || null,
  avatar: u.avatar_url,
}));

writeFileSync('frontend/users.json', JSON.stringify(data));
console.log(`${data.length} users saved to frontend/users.json`);
