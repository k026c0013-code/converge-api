import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { authenticate } from '../auth/authenticate.js';
import { toPublicUser } from '../auth/service.js';
import type { AuthConfig } from '../config.js';
import { unauthorized } from '../errors.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { UserView, errors } from '../schemas.js';

export interface UserRoutesOptions {
  prisma: PrismaClient;
  auth: AuthConfig;
}

export const userRoutes: FastifyPluginAsyncTypebox<UserRoutesOptions> = async (app, opts) => {
  app.addHook('onRequest', authenticate(opts.auth));

  app.get(
    '/me',
    {
      schema: {
        tags: ['users'],
        summary: 'The signed-in user',
        security: [{ bearerAuth: [] }],
        response: { 200: UserView, ...errors(401, 429) },
      },
    },
    async (request) => {
      const user = await opts.prisma.user.findUnique({ where: { id: request.userId } });
      if (!user) throw unauthorized();
      return toPublicUser(user);
    },
  );
};
