import { prepareDdlExtractor, DdlParseError } from '../src'

describe('prepareDdlExtractor (skeleton)', () => {
  describe('parse failures', () => {
    test('throws DdlParseError on invalid SQL', async () => {
      await expect(prepareDdlExtractor('CREATE TABLE (')).rejects.toThrow(DdlParseError)
    })

    test('resolves on valid SQL', async () => {
      await expect(prepareDdlExtractor('CREATE TABLE x (id int);')).resolves.toBeDefined()
    })

    test('empty input yields an extractor with no tables', async () => {
      const ex = await prepareDdlExtractor('   \n  ')
      expect(ex.tables()).toEqual([])
    })
  })

  describe('table discovery', () => {
    const ddl = `
CREATE TABLE public.orders (id int);
CREATE SEQUENCE s;
CREATE TABLE inventory (sku text);
CREATE TABLE audit.events (id int);
`

    test('tables() lists only CREATE TABLE’d tables in source order', async () => {
      const ex = await prepareDdlExtractor(ddl)
      expect(ex.tables()).toEqual([
        { schema: 'public', name: 'orders' },
        { schema: 'public', name: 'inventory' },
        { schema: 'audit', name: 'events' },
      ])
    })

    test('PARTITION OF tables are excluded (out of scope, matching buildFromDdl)', async () => {
      const ex = await prepareDdlExtractor(
        'CREATE TABLE measurement (logdate date) PARTITION BY RANGE (logdate);\n' +
          'CREATE TABLE measurement_y2024 PARTITION OF measurement FOR VALUES FROM (\'2024-01-01\') TO (\'2025-01-01\');',
      )
      expect(ex.tables()).toEqual([{ schema: 'public', name: 'measurement' }])
    })
  })

  describe('extractTable', () => {
    test('returns the verbatim CREATE TABLE slice for a discovered table', async () => {
      const ex = await prepareDdlExtractor(
        'CREATE TABLE public.orders (id int);\nCREATE TABLE inventory (sku text);',
      )
      const slice = ex.extractTable({ schema: 'public', name: 'inventory' })
      expect(slice).toBeDefined()
      expect(slice!.sql).toBe('CREATE TABLE inventory (sku text);')
      expect(slice!.table).toEqual({ schema: 'public', name: 'inventory' })
      expect(slice!.warnings).toEqual([])
    })

    test('every ref from tables() round-trips through extractTable', async () => {
      const ddl = 'CREATE TABLE a (id int);\nCREATE TABLE audit.b (id int);'
      const ex = await prepareDdlExtractor(ddl)
      for (const ref of ex.tables()) {
        const slice = ex.extractTable(ref)
        expect(slice).toBeDefined()
        expect(slice!.sql).toContain(ref.name)
      }
    })

    test('unknown table is a lookup miss → undefined (not a throw)', async () => {
      const ex = await prepareDdlExtractor('CREATE TABLE x (id int);')
      expect(ex.extractTable({ schema: 'public', name: 'nope' })).toBeUndefined()
      expect(ex.extractTable({ schema: 'other', name: 'x' })).toBeUndefined()
    })

    test('quoted mixed-case identifier is found via its normalized name, not lowercased', async () => {
      const ex = await prepareDdlExtractor('CREATE TABLE "MyTable" (id int);')
      expect(ex.tables()).toEqual([{ schema: 'public', name: 'MyTable' }])
      expect(ex.extractTable({ schema: 'public', name: 'MyTable' })).toBeDefined()
      // The extractor never re-folds caller strings:
      expect(ex.extractTable({ schema: 'public', name: 'mytable' })).toBeUndefined()
    })
  })

  describe('basic relevance closure', () => {
    test('includes the table, its indexes, triggers, and owned comments; omits unrelated', async () => {
      const ddl = [
        'CREATE TABLE orders (id int, total numeric);',
        'CREATE INDEX idx_orders_total ON orders (total);',
        "COMMENT ON TABLE orders IS 'the orders';",
        'CREATE TABLE other (id int);',
        'CREATE INDEX idx_other ON other (id);',
      ].join('\n')
      const ex = await prepareDdlExtractor(ddl)
      const sql = ex.extractTable({ schema: 'public', name: 'orders' })!.sql
      // orders' own statements are contiguous (0..2) → copied verbatim.
      expect(sql).toBe(
        [
          'CREATE TABLE orders (id int, total numeric);',
          'CREATE INDEX idx_orders_total ON orders (total);',
          "COMMENT ON TABLE orders IS 'the orders';",
        ].join('\n'),
      )
      expect(sql).not.toContain('other')
    })

    test('includes triggers and column comments owned by the table', async () => {
      const ddl = [
        'CREATE TABLE orders (id int, total numeric);',
        'CREATE TRIGGER trg AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION f();',
        "COMMENT ON COLUMN orders.total IS 'amount';",
      ].join('\n')
      const ex = await prepareDdlExtractor(ddl)
      const sql = ex.extractTable({ schema: 'public', name: 'orders' })!.sql
      expect(sql).toContain('CREATE TRIGGER trg')
      expect(sql).toContain("COMMENT ON COLUMN orders.total IS 'amount'")
    })

    test('COMMENT ON INDEX is attributed to the owning table', async () => {
      const ddl = [
        'CREATE TABLE a (id int);',
        'CREATE INDEX idx_a ON a (id);',
        "COMMENT ON INDEX idx_a IS 'speedy';",
      ].join('\n')
      const ex = await prepareDdlExtractor(ddl)
      const sql = ex.extractTable({ schema: 'public', name: 'a' })!.sql
      expect(sql).toContain("COMMENT ON INDEX idx_a IS 'speedy'")
    })

    test('COMMENT ON INDEX for a named UNIQUE constraint index is attributed to its table', async () => {
      const ddl = [
        'CREATE TABLE t (id int, code text, CONSTRAINT uq_code UNIQUE (code));',
        "COMMENT ON INDEX uq_code IS 'unique codes';",
      ].join('\n')
      const ex = await prepareDdlExtractor(ddl)
      const sql = ex.extractTable({ schema: 'public', name: 't' })!.sql
      expect(sql).toContain("COMMENT ON INDEX uq_code IS 'unique codes'")
    })

    test('COMMENT ON INDEX for an inline named UNIQUE column constraint is attributed', async () => {
      const ddl = [
        'CREATE TABLE t (id int, code text CONSTRAINT uq_code UNIQUE);',
        "COMMENT ON INDEX uq_code IS 'unique codes';",
      ].join('\n')
      const ex = await prepareDdlExtractor(ddl)
      const sql = ex.extractTable({ schema: 'public', name: 't' })!.sql
      expect(sql).toContain("COMMENT ON INDEX uq_code IS 'unique codes'")
    })

    test('non-contiguous selection preserves source order with a normalized seam', async () => {
      const ddl = [
        'CREATE TABLE a (id int);',
        'CREATE TABLE b (id int);', // dropped from a's slice
        'CREATE INDEX idx_a ON a (id);',
      ].join('\n')
      const ex = await prepareDdlExtractor(ddl)
      const sql = ex.extractTable({ schema: 'public', name: 'a' })!.sql
      expect(sql).toBe('CREATE TABLE a (id int);\n\nCREATE INDEX idx_a ON a (id);')
      expect(sql).not.toContain('TABLE b')
    })

    test('a column comment on a different table is not pulled in', async () => {
      const ddl = [
        'CREATE TABLE a (id int);',
        'CREATE TABLE b (id int);',
        "COMMENT ON COLUMN b.id IS 'b only';",
      ].join('\n')
      const ex = await prepareDdlExtractor(ddl)
      const sql = ex.extractTable({ schema: 'public', name: 'a' })!.sql
      expect(sql).toBe('CREATE TABLE a (id int);')
    })

    test('one extractor serves many tables (reuse)', async () => {
      const ddl = [
        'CREATE TABLE a (id int);',
        'CREATE INDEX idx_a ON a (id);',
        'CREATE TABLE b (id int);',
        'CREATE INDEX idx_b ON b (id);',
      ].join('\n')
      const ex = await prepareDdlExtractor(ddl)
      const a = ex.extractTable({ schema: 'public', name: 'a' })!.sql
      const b = ex.extractTable({ schema: 'public', name: 'b' })!.sql
      expect(a).toContain('idx_a')
      expect(a).not.toContain('idx_b')
      expect(b).toContain('idx_b')
      expect(b).not.toContain('idx_a')
    })
  })

  describe('type-dependency closure', () => {
    const extract = async (ddl: string, name: string, schema = 'public') =>
      (await prepareDdlExtractor(ddl)).extractTable({ schema, name })!.sql

    test('column → enum type is included; unused types are not', async () => {
      const sql = await extract(
        [
          "CREATE TYPE mood AS ENUM ('happy', 'sad');",
          'CREATE TABLE person (id int, m mood);',
          "CREATE TYPE unused AS ENUM ('x');",
        ].join('\n'),
        'person',
      )
      expect(sql).toContain('CREATE TYPE mood AS ENUM')
      expect(sql).not.toContain('unused')
    })

    test('transitive: column → composite → enum', async () => {
      const sql = await extract(
        [
          "CREATE TYPE mood AS ENUM ('happy');",
          'CREATE TYPE profile AS (status mood, bio text);',
          'CREATE TABLE person (id int, p profile);',
        ].join('\n'),
        'person',
      )
      expect(sql).toContain('CREATE TYPE profile AS')
      expect(sql).toContain('CREATE TYPE mood AS ENUM')
    })

    test('transitive: column → domain → base domain', async () => {
      const sql = await extract(
        [
          'CREATE DOMAIN positive AS int CHECK (VALUE > 0);',
          'CREATE DOMAIN small_positive AS positive CHECK (VALUE < 100);',
          'CREATE TABLE t (id int, q small_positive);',
        ].join('\n'),
        't',
      )
      expect(sql).toContain('CREATE DOMAIN small_positive')
      expect(sql).toContain('CREATE DOMAIN positive')
    })

    test('array element type (mood[]) is detected', async () => {
      const sql = await extract(
        ["CREATE TYPE mood AS ENUM ('a');", 'CREATE TABLE t (id int, moods mood[]);'].join('\n'),
        't',
      )
      expect(sql).toContain('CREATE TYPE mood AS ENUM')
    })

    test('schema-qualified type reference is resolved as-is', async () => {
      const sql = await extract(
        ["CREATE TYPE audit.mood AS ENUM ('a');", 'CREATE TABLE public.t (id int, m audit.mood);'].join('\n'),
        't',
      )
      expect(sql).toContain('CREATE TYPE audit.mood AS ENUM')
    })

    test('expression-cast-only reference pulls the type in (diverges from buildFromDdl)', async () => {
      const sql = await extract(
        [
          "CREATE TYPE mood AS ENUM ('a', 'b');",
          "CREATE TABLE t (id int, s text, CHECK (s::mood = 'a'));",
        ].join('\n'),
        't',
      )
      expect(sql).toContain('CREATE TYPE mood AS ENUM')
    })

    test('a type used only in an included index expression is pulled in', async () => {
      const sql = await extract(
        [
          "CREATE TYPE mood AS ENUM ('a', 'b');",
          'CREATE TABLE t (id int, s text);',
          'CREATE INDEX idx ON t ((s::mood));',
        ].join('\n'),
        't',
      )
      expect(sql).toContain('CREATE INDEX idx')
      expect(sql).toContain('CREATE TYPE mood AS ENUM')
    })

    test('a type used only in an included index WHERE predicate is pulled in', async () => {
      const sql = await extract(
        [
          "CREATE TYPE mood AS ENUM ('a', 'b');",
          'CREATE TABLE t (id int, s text);',
          "CREATE INDEX idx ON t (id) WHERE (s::mood = 'a');",
        ].join('\n'),
        't',
      )
      expect(sql).toContain('CREATE TYPE mood AS ENUM')
    })

    test('a type used only in an included trigger WHEN clause is pulled in', async () => {
      const sql = await extract(
        [
          "CREATE TYPE mood AS ENUM ('a', 'b');",
          'CREATE TABLE t (id int, s text);',
          "CREATE TRIGGER trg BEFORE UPDATE ON t FOR EACH ROW WHEN (NEW.s::mood = 'a') EXECUTE FUNCTION f();",
        ].join('\n'),
        't',
      )
      expect(sql).toContain('CREATE TRIGGER trg')
      expect(sql).toContain('CREATE TYPE mood AS ENUM')
    })

    test('COMMENT ON TYPE is included for a used type, excluded for an unused one', async () => {
      const sql = await extract(
        [
          "CREATE TYPE mood AS ENUM ('a');",
          "COMMENT ON TYPE mood IS 'feelings';",
          "CREATE TYPE unused AS ENUM ('x');",
          "COMMENT ON TYPE unused IS 'nope';",
          'CREATE TABLE t (id int, m mood);',
        ].join('\n'),
        't',
      )
      expect(sql).toContain("COMMENT ON TYPE mood IS 'feelings'")
      expect(sql).not.toContain('unused')
      expect(sql).not.toContain('nope')
    })

    test('a self-referential composite type terminates (cycle guard)', async () => {
      const sql = await extract(
        ['CREATE TYPE node AS (next node, val int);', 'CREATE TABLE t (id int, n node);'].join('\n'),
        't',
      )
      expect(sql).toContain('CREATE TYPE node AS')
      // included exactly once despite the self-reference
      expect(sql.match(/CREATE TYPE node AS/g)).toHaveLength(1)
    })
  })

  describe('LIKE closure', () => {
    const extract = async (ddl: string, name: string, schema = 'public') =>
      (await prepareDdlExtractor(ddl)).extractTable({ schema, name })!.sql

    test('LIKE source is pulled in as a full closure (its table, index, comment, types)', async () => {
      const sql = await extract(
        [
          "CREATE TYPE mood AS ENUM ('a');",
          'CREATE TABLE base (id int, m mood);',
          'CREATE INDEX idx_base ON base (id);',
          "COMMENT ON TABLE base IS 'the base';",
          'CREATE TABLE child (LIKE base, extra text);',
        ].join('\n'),
        'child',
      )
      expect(sql).toContain('CREATE TABLE child')
      expect(sql).toContain('CREATE TABLE base')
      expect(sql).toContain('idx_base')
      expect(sql).toContain("COMMENT ON TABLE base IS 'the base'")
      expect(sql).toContain('CREATE TYPE mood AS ENUM')
    })

    test('a LIKE chain pulls in every ancestor', async () => {
      const sql = await extract(
        [
          'CREATE TABLE a (id int);',
          'CREATE TABLE b (LIKE a, b1 text);',
          'CREATE TABLE c (LIKE b, c1 text);',
        ].join('\n'),
        'c',
      )
      expect(sql).toContain('CREATE TABLE c')
      expect(sql).toContain('CREATE TABLE b')
      expect(sql).toContain('CREATE TABLE a')
    })

    test('a mutually-referential LIKE pair terminates (cycle guard)', async () => {
      const sql = await extract(
        ['CREATE TABLE a (LIKE b, x int);', 'CREATE TABLE b (LIKE a, y int);'].join('\n'),
        'a',
      )
      expect(sql).toContain('CREATE TABLE a')
      expect(sql).toContain('CREATE TABLE b')
      expect(sql.match(/CREATE TABLE a/g)).toHaveLength(1)
    })
  })

  describe('warnings', () => {
    const slice = async (ddl: string, name: string, schema = 'public') =>
      (await prepareDdlExtractor(ddl)).extractTable({ schema, name })!

    test('OmittedForeignKeyTarget — FK to a table not included (structured refTable)', async () => {
      const r = await slice(
        [
          'CREATE TABLE orders (id int, customer_id int CONSTRAINT fk_cust REFERENCES customers (id));',
          'CREATE TABLE customers (id int);',
        ].join('\n'),
        'orders',
      )
      expect(r.sql).not.toContain('CREATE TABLE customers') // FK target excluded by design
      const fk = r.warnings.find(w => w.kind === 'OmittedForeignKeyTarget')
      expect(fk).toMatchObject({
        kind: 'OmittedForeignKeyTarget',
        refTable: { schema: 'public', name: 'customers' },
        symbol: 'fk_cust',
      })
    })

    test('a self-referential FK does not warn (target is included)', async () => {
      const r = await slice('CREATE TABLE node (id int, parent_id int REFERENCES node (id));', 'node')
      expect(r.warnings.find(w => w.kind === 'OmittedForeignKeyTarget')).toBeUndefined()
    })

    test('DuplicateTable — first definition wins and is emitted', async () => {
      const r = await slice(
        ['CREATE TABLE t (id int);', 'CREATE TABLE t (id int, extra text);'].join('\n'),
        't',
      )
      expect(r.sql).toBe('CREATE TABLE t (id int);')
      expect(r.warnings.find(w => w.kind === 'DuplicateTable')).toMatchObject({
        kind: 'DuplicateTable',
        table: { schema: 'public', name: 't' },
      })
    })

    test('OutOfScopeStatementDropped — ALTER TABLE naming the table', async () => {
      const r = await slice(
        ['CREATE TABLE t (id int);', 'ALTER TABLE t ADD COLUMN x text;'].join('\n'),
        't',
      )
      expect(r.sql).not.toContain('ALTER TABLE')
      expect(r.warnings.find(w => w.kind === 'OutOfScopeStatementDropped')).toMatchObject({
        kind: 'OutOfScopeStatementDropped',
        statementType: 'AlterTableStmt',
      })
    })

    test('UnresolvedTypeReference — unknown user type warns, extension type does not', async () => {
      const r = await slice('CREATE TABLE t (id int, c citext, w widget);', 't')
      const unresolved = r.warnings
        .filter(w => w.kind === 'UnresolvedTypeReference')
        .map(w => (w as { typeName: string }).typeName)
      expect(unresolved).toEqual(['widget']) // citext is a known extension type → suppressed
    })

    test('a clean table produces no warnings', async () => {
      const r = await slice('CREATE TABLE t (id int, name text, active boolean);', 't')
      expect(r.warnings).toEqual([])
    })
  })

  describe('end-to-end (realistic multi-table DDL)', () => {
    const ddl = `-- Enumerations
CREATE TYPE order_status AS ENUM ('pending', 'shipped');

CREATE TABLE customers (
  id bigint PRIMARY KEY,
  email text NOT NULL
);
COMMENT ON TABLE customers IS 'People who buy things';

CREATE TABLE orders (
  id bigint PRIMARY KEY,
  customer_id bigint REFERENCES customers (id),
  status order_status NOT NULL
);
CREATE INDEX idx_orders_customer ON orders (customer_id);
COMMENT ON COLUMN orders.status IS 'lifecycle';

CREATE SEQUENCE audit_seq;

CREATE TABLE orders_archive (LIKE orders);`

    test('tables() lists every table (sequence excluded), in source order', async () => {
      const ex = await prepareDdlExtractor(ddl)
      expect(ex.tables()).toEqual([
        { schema: 'public', name: 'customers' },
        { schema: 'public', name: 'orders' },
        { schema: 'public', name: 'orders_archive' },
      ])
    })

    test('every table round-trips to a non-empty slice', async () => {
      const ex = await prepareDdlExtractor(ddl)
      for (const ref of ex.tables()) {
        expect(ex.extractTable(ref)!.sql.length).toBeGreaterThan(0)
      }
    })

    test('customers: just its table + comment, nothing from orders', async () => {
      const ex = await prepareDdlExtractor(ddl)
      const r = ex.extractTable({ schema: 'public', name: 'customers' })!
      expect(r.sql).toContain('CREATE TABLE customers')
      expect(r.sql).toContain("COMMENT ON TABLE customers IS 'People who buy things'")
      expect(r.sql).not.toContain('orders')
      expect(r.warnings).toEqual([])
    })

    test('orders: pulls its index, column comment, used enum; omits FK target with a warning', async () => {
      const ex = await prepareDdlExtractor(ddl)
      const r = ex.extractTable({ schema: 'public', name: 'orders' })!
      expect(r.sql).toContain("CREATE TYPE order_status AS ENUM ('pending', 'shipped')")
      expect(r.sql).toContain('CREATE TABLE orders')
      expect(r.sql).toContain('CREATE INDEX idx_orders_customer')
      expect(r.sql).toContain("COMMENT ON COLUMN orders.status IS 'lifecycle'")
      expect(r.sql).not.toContain('CREATE TABLE customers')
      expect(r.sql).not.toContain('audit_seq')
      expect(r.warnings).toContainEqual(
        expect.objectContaining({ kind: 'OmittedForeignKeyTarget', refTable: { schema: 'public', name: 'customers' } }),
      )
    })

    test('orders_archive: LIKE pulls in orders and its closure (enum, index, comment)', async () => {
      const ex = await prepareDdlExtractor(ddl)
      const r = ex.extractTable({ schema: 'public', name: 'orders_archive' })!
      expect(r.sql).toContain('CREATE TABLE orders_archive')
      expect(r.sql).toContain('CREATE TABLE orders')
      expect(r.sql).toContain('CREATE TYPE order_status')
      expect(r.sql).toContain('CREATE INDEX idx_orders_customer')
      // orders' FK target (customers) is still omitted → warning carries through the LIKE source.
      expect(r.warnings).toContainEqual(
        expect.objectContaining({ kind: 'OmittedForeignKeyTarget', refTable: { schema: 'public', name: 'customers' } }),
      )
    })
  })
})
