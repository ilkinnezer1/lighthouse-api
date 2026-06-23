import { z } from 'zod';

const MAX_CONTENT_BYTES = 262144;

export const pathSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((p) => !p.startsWith('/'), 'path must be relative')
  .refine(
    (p) => !p.split('/').includes('..'),
    'path must not contain a ".." segment',
  )
  .refine((p) => !p.startsWith('.git/'), 'path must not start with ".git/"');

export const PutManagedFileSchema = z.object({
  path: pathSchema,
  content: z
    .string()
    .refine(
      (c) => Buffer.byteLength(c, 'utf8') <= MAX_CONTENT_BYTES,
      'content exceeds 256 KB',
    ),
});

export type PutManagedFileDto = z.infer<typeof PutManagedFileSchema>;

export const DeleteManagedFileSchema = z.object({ path: pathSchema });

export type DeleteManagedFileDto = z.infer<typeof DeleteManagedFileSchema>;

export const FileContentQuerySchema = z.object({ path: pathSchema });

export type FileContentQueryDto = z.infer<typeof FileContentQuerySchema>;
