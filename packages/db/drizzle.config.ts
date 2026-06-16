import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: ['./src/schema.ts', './src/auth-schema.ts'],
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://hub:hub@localhost:48802/hub' },
})
