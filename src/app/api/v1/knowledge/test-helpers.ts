// Shared in-memory fake of the one table the knowledge routes touch.
// Test-only; not imported by app code.

export interface FakeDoc {
  id: string;
  account_id: string;
  created_by: string | null;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export function makeFakeDb(initial: FakeDoc[] = []) {
  const docs: FakeDoc[] = [...initial];
  let seq = 0;
  const failNext: { op: 'insert' | 'update' | 'delete' | 'select' | null } = { op: null };

  function from(table: string) {
    if (table !== 'ai_knowledge_documents') throw new Error(`unexpected table ${table}`);
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Record<string, unknown> = {};
    const eqs: Array<[string, unknown]> = [];
    let like: string | null = null;
    let limitN = Infinity;
    let wantsRows = false;

    const matches = () =>
      docs.filter(
        (d) =>
          eqs.every(([k, v]) => (d as unknown as Record<string, unknown>)[k] === v) &&
          (like === null ||
            d.title.toLowerCase() === like.replace(/\\(.)/g, '$1').toLowerCase())
      );

    const run = () => {
      if (failNext.op === op) {
        failNext.op = null;
        return { data: null, error: { message: 'boom' } };
      }
      if (op === 'insert') {
        const row: FakeDoc = {
          id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
          created_at: new Date(2026, 0, seq).toISOString(),
          updated_at: new Date(2026, 0, seq).toISOString(),
          created_by: null,
          ...(payload as Partial<FakeDoc>),
        } as FakeDoc;
        docs.push(row);
        return { data: row, error: null };
      }
      const found = matches();
      if (op === 'update') {
        for (const d of found) Object.assign(d, payload);
        return { data: found[0] ?? null, error: null };
      }
      if (op === 'delete') {
        for (const d of found) docs.splice(docs.indexOf(d), 1);
        return { data: found[0] ?? null, error: null };
      }
      const sorted = [...found].sort((a, b) =>
        a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0
      );
      return { data: sorted.slice(0, limitN), error: null };
    };

    const builder: Record<string, unknown> = {
      select: () => {
        wantsRows = true;
        return builder;
      },
      insert: (row: Record<string, unknown>) => {
        op = 'insert';
        payload = row;
        return builder;
      },
      update: (row: Record<string, unknown>) => {
        op = 'update';
        payload = row;
        return builder;
      },
      delete: () => {
        op = 'delete';
        return builder;
      },
      eq: (k: string, v: unknown) => {
        eqs.push([k, v]);
        return builder;
      },
      ilike: (_k: string, pattern: string) => {
        like = pattern;
        return builder;
      },
      or: () => builder,
      order: () => builder,
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      single: async () => {
        const r = run();
        return r.error || r.data ? r : { data: null, error: { message: 'no rows' } };
      },
      maybeSingle: async () => {
        const r = run();
        const d = r.data;
        return { data: Array.isArray(d) ? (d[0] ?? null) : d, error: r.error };
      },
      then: (resolve: (v: unknown) => void) => resolve(run()),
    };
    void wantsRows;
    return builder;
  }

  return { docs, db: { from }, failNext };
}
