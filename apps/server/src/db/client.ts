import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client.js';

/** Creates a Prisma client for a mysql:// URL using the MariaDB driver adapter (works with MySQL 8). */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'mysql:' && url.protocol !== 'mariadb:') {
    throw new Error('DATABASE_URL must be a mysql:// URL');
  }
  const adapter = new PrismaMariaDb({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
    connectionLimit: 10,
    // Fail fast when the DB is down or credentials are wrong (driver defaults wait far longer).
    connectTimeout: 3_000,
    acquireTimeout: 5_000,
    // MySQL 8 caching_sha2_password over a non-TLS local socket needs the server's RSA key.
    // Local development only; production must use TLS (requirements §13).
    allowPublicKeyRetrieval: true,
  });
  return new PrismaClient({ adapter });
}
