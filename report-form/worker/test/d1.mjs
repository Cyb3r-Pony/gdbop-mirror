// A minimal Cloudflare D1 stand-in over node:sqlite, with the real migrations
// applied, so the intel SQL runs against an actual SQLite engine in tests.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../migrations/', import.meta.url);

export const makeD1 = ({ failOn } = {}) => {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  const check = (sql) => {
    if (failOn && failOn.test(sql)) throw new Error('D1_ERROR');
  };
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => { check(sql); return { results: db.prepare(sql).all(...args), success: true }; },
    first: async () => { check(sql); return db.prepare(sql).get(...args) ?? null; },
    run: async () => { check(sql); db.prepare(sql).run(...args); return { success: true }; },
    exec: () => { check(sql); db.prepare(sql).run(...args); },
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      db.exec('BEGIN');
      try {
        for (const s of list) s.exec();
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return list.map(() => ({ success: true }));
    },
    rows: (sql, ...args) => db.prepare(sql).all(...args),
  };
};
