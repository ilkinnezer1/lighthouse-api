import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { User } from '@prisma/client';
import type { Socket } from 'socket.io';
import type { JwtPayload } from '../auth/auth.service';
import type { UsersService } from '../users/users.service';

export type SocketUser = Pick<User, 'id' | 'role'>;

interface SocketData {
  user?: SocketUser;
}

const SESSION_COOKIE = 'session';

// Verifies the session cookie and stores the user on `client.data`.
// Throws UnauthorizedException if the cookie is missing or invalid.
export async function authenticateSocket(
  client: Socket,
  jwt: JwtService,
  users: UsersService,
): Promise<SocketUser> {
  const token = readCookie(client.handshake.headers.cookie, SESSION_COOKIE);
  if (!token) throw new UnauthorizedException('missing session cookie');

  const { sub } = jwt.verify<JwtPayload>(token);
  const user = await users.findById(sub);
  if (!user?.isActive) throw new UnauthorizedException('invalid session');

  const principal: SocketUser = { id: user.id, role: user.role };
  (client.data as SocketData).user = principal;
  return principal;
}

export function getSocketUser(client: Socket): SocketUser | undefined {
  return (client.data as SocketData).user;
}

// cookie-parser only runs on Express HTTP requests, not on the WS upgrade,
// so we parse the raw header ourselves.
function readCookie(raw: string | undefined, name: string): string | null {
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    if (decodeURIComponent(trimmed.slice(0, idx)) === name) {
      return decodeURIComponent(trimmed.slice(idx + 1));
    }
  }
  return null;
}
