import { Type } from 'typebox';

/** Shared response/request schemas. Every object schema rejects unknown properties. */

export const Uuid = Type.String({ format: 'uuid' });

export const ErrorResponse = Type.Object(
  {
    error: Type.Object({
      code: Type.String(),
      message: Type.String(),
      details: Type.Optional(Type.Array(Type.Unknown())),
    }),
  },
);

export const Email = Type.String({ format: 'email', minLength: 3, maxLength: 254 });
export const Password = Type.String({ minLength: 8, maxLength: 128 });
export const DisplayName = Type.String({ minLength: 1, maxLength: 50, pattern: '\\S' });

export const UserView = Type.Object({
  id: Uuid,
  email: Type.String(),
  displayName: Type.String(),
  createdAt: Type.String({ format: 'date-time' }),
});

export const TokenPair = Type.Object({
  tokenType: Type.Literal('Bearer'),
  accessToken: Type.String(),
  /** Seconds until the access token expires. */
  expiresIn: Type.Integer(),
  refreshToken: Type.String(),
});

export const Role = Type.Union([Type.Literal('owner'), Type.Literal('editor'), Type.Literal('viewer')]);
export const MemberRole = Type.Union([Type.Literal('editor'), Type.Literal('viewer')]);

export const DocumentView = Type.Object({
  id: Uuid,
  title: Type.String(),
  ownerId: Uuid,
  engine: Type.String(),
  formatVersion: Type.Integer(),
  myRole: Role,
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});

export const MemberView = Type.Object({
  userId: Uuid,
  displayName: Type.String(),
  /** Only included for the document owner (ADR-0008 §2). */
  email: Type.Optional(Type.String()),
  role: Role,
  joinedAt: Type.String({ format: 'date-time' }),
});

export const Title = Type.String({ minLength: 1, maxLength: 200, pattern: '\\S' });

/** Standard error responses for the OpenAPI document. */
export function errors(...codes: number[]): Record<number, typeof ErrorResponse> {
  return Object.fromEntries(codes.map((c) => [c, ErrorResponse]));
}

export const strict = { additionalProperties: false } as const;
