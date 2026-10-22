import { defineConfig } from 'drizzle-kit';

export default defineConfig({
    dialect: 'postgresql',
    schema: './src/database/schema.ts',
    out: './drizzle',
    dbCredentials: {
        url: process.env.DATABASE_URL ?? 'postgresql://phoneos:CHANGE_ME@127.0.0.1:5432/phoneos',
    },
    strict: true,
    verbose: true,
});
