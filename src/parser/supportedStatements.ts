// Private module — the single source of truth for which pgsql-parser top-level
// statement types ddlapi supports.
//
// Both buildFromDdl (its dispatch) and the table-DDL extractor (its eligibility
// filter) consume this list, so the extractor's selectable set cannot drift from
// what buildFromDdl actually handles. buildFromDdl's dispatch switch is made
// exhaustive over SupportedStmtType (assertNever), so adding a name here fails to
// compile until a handler case exists.

/** pgsql-parser top-level statement type-name keys that ddlapi supports. */
export const SUPPORTED_STMT_TYPES = [
  'CreateStmt',        // CREATE TABLE
  'IndexStmt',         // CREATE [UNIQUE] INDEX
  'CommentStmt',       // COMMENT ON ...
  'CreateDomainStmt',  // CREATE DOMAIN
  'CreateEnumStmt',    // CREATE TYPE ... AS ENUM
  'CompositeTypeStmt', // CREATE TYPE ... AS (...)
  'CreateRangeStmt',   // CREATE TYPE ... AS RANGE
  'CreateTrigStmt',    // CREATE TRIGGER
] as const

export type SupportedStmtType = typeof SUPPORTED_STMT_TYPES[number]

export const SUPPORTED_STMT_TYPE_SET: ReadonlySet<string> = new Set(SUPPORTED_STMT_TYPES)
