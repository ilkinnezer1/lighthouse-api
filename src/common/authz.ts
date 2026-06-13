import { User } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';

export type Action =
  | 'projects.read'
  | 'projects.update'
  | 'projects.delete'
  | 'environments.read'
  | 'environments.update'
  | 'environments.delete'
  | 'deployments.create'
  | 'deployments.read'
  | 'deployments.update'
  | 'deployments.cancel'
  | 'deployments.exec'
  | 'databases.create'
  | 'databases.read'
  | 'databases.delete'
  | 'snapshots.create'
  | 'snapshots.read'
  | 'snapshots.restore'
  | 'snapshots.delete';

export interface OwnedResource {
  ownerId: string;
}
export function can(
  user: Pick<User, 'id' | 'role'>,
  _action: Action,
  resource: OwnedResource,
): boolean {
  if (user.role === 'ADMIN') return true;
  return resource.ownerId === user.id;
}

export function ensureCan(
  user: Pick<User, 'id' | 'role'>,
  action: Action,
  resource: OwnedResource,
): void {
  if (!can(user, action, resource)) {
    throw new ForbiddenException(`Not allowed: ${action}`);
  }
}
