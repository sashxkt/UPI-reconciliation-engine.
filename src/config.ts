try {
  process.loadEnvFile();
} catch {
  // No .env file. That's fine, we just read the real environment.
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name}. See .env.example.`);
  }
  return value;
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  webhookSecret: required('WEBHOOK_SECRET'),
  hospitalVpa: process.env.HOSPITAL_VPA ?? 'cityclinic@okhdfc',
  hospitalName: process.env.HOSPITAL_NAME ?? 'City Clinic',
  port: Number(process.env.PORT ?? 3000),
};
