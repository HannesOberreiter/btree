import httpErrors from 'http-errors';

export type MappedDatabaseError = Error & {
  statusCode?: number;
  code?: string;
  details?: Record<string, unknown>;
};

/** The codes that checkMySQLError assigns to mapped database errors. */
const MAPPED_DATABASE_ERROR_CODES = new Set([
  'NOT_FOUND',
  'UNIQUE_VIOLATION',
  'CONCURRENT_UPDATE',
  'FOREIGN_KEY_VIOLATION',
  'INVALID_DATA',
]);

/**
 * Whether the error is a database error mapped by checkMySQLError, also when
 * a module already mapped and rethrew it (for example a deadlock mapped to a
 * 409 CONCURRENT_UPDATE).
 */
export function isMappedDatabaseError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && MAPPED_DATABASE_ERROR_CODES.has(code);
}

type DatabaseErrorShape = Error & {
  code?: string;
  errno?: number;
  sqlState?: string;
  sqlMessage?: string;
};

export function checkMySQLError(error: unknown): MappedDatabaseError {
  if (!(error instanceof Error)) {
    return httpErrors.InternalServerError('Unknown error');
  }
  const databaseError = error as DatabaseErrorShape;
  if (databaseError.name === 'NoResultError') {
    const mapped = httpErrors.NotFound(error.message) as MappedDatabaseError;
    mapped.code = 'NOT_FOUND';
    return mapped;
  }
  if (databaseError.code === 'ER_DUP_ENTRY') {
    const mapped = httpErrors.Conflict('duplicate') as MappedDatabaseError;
    mapped.code = 'UNIQUE_VIOLATION';
    return mapped;
  }
  if (
    databaseError.code === 'ER_LOCK_DEADLOCK' ||
    databaseError.code === 'ER_LOCK_WAIT_TIMEOUT'
  ) {
    // Two requests changed the same rows at the same time. A retry works.
    const mapped = httpErrors.Conflict(
      'concurrentUpdate',
    ) as MappedDatabaseError;
    mapped.code = 'CONCURRENT_UPDATE';
    return mapped;
  }
  if (
    databaseError.code === 'ER_NO_REFERENCED_ROW_2' ||
    databaseError.code === 'ER_ROW_IS_REFERENCED_2'
  ) {
    const mapped = httpErrors.Conflict('foreignKey') as MappedDatabaseError;
    mapped.code = 'FOREIGN_KEY_VIOLATION';
    return mapped;
  }
  if (
    databaseError.code === 'ER_BAD_NULL_ERROR' ||
    databaseError.code === 'ER_DATA_TOO_LONG' ||
    databaseError.code === 'ER_TRUNCATED_WRONG_VALUE' ||
    databaseError.code === 'WARN_DATA_TRUNCATED'
  ) {
    const mapped = httpErrors.BadRequest('invalidData') as MappedDatabaseError;
    mapped.code = 'INVALID_DATA';
    return mapped;
  }
  return error;
}
