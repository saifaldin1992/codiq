/**
 * The Worker in front of the platform container.
 *
 * Every request — storefront, dashboards, API, every merchant's host name — is
 * forwarded unchanged (Host and CF-Connecting-IP included) to one of
 * `INSTANCES` container instances. The container is the ordinary Node server
 * from the repository Dockerfile; nothing in the app knows it runs here.
 *
 * Secrets live as Worker secrets (`wrangler secret put`) and are handed to the
 * container as environment variables at start. Only names on PASSTHROUGH cross
 * the boundary, so a binding added to the Worker never leaks into the app.
 */
import { Container, getContainer, getRandom } from "@cloudflare/containers";

/** Every variable the app reads (see .env.example). */
const PASSTHROUGH = [
  "NODE_ENV",
  "CODIQ_PUBLIC_BASE_URL",
  "CODIQ_POSTGRES_URL",
  "CODIQ_POSTGRES_URL_UNPOOLED",
  "SESSION_JWT_SECRET",
  "SESSION_JWT_SECRET_PREVIOUS",
  "CODIQ_ENCRYPTION_KEY",
  "CODIQ_ENCRYPTION_KEY_PREVIOUS",
  "PRODUCT_S3_ENDPOINT",
  "PRODUCT_S3_REGION",
  "PRODUCT_S3_BUCKET",
  "PRODUCT_S3_ACCESS_KEY_ID",
  "PRODUCT_S3_SECRET_ACCESS_KEY",
  "PRODUCT_S3_FORCE_PATH_STYLE",
  "CODIQ_MAIL_FROM",
  "CODIQ_SUPPORT_EMAIL",
  "CODIQ_RESEND_API_KEY",
  "CODIQ_RESEND_WEBHOOK_SECRET",
  "CODIQ_SMTP_HOST",
  "CODIQ_SMTP_PORT",
  "CODIQ_SMTP_SECURE",
  "CODIQ_SMTP_USER",
  "CODIQ_SMTP_PASS",
  "CODIQ_SMTP_FROM",
  "CODIQ_TRUSTED_EDGE",
  "CODIQ_COOKIE_SECURE",
  "CODIQ_NOTIFICATIONS_WORKER",
  "CODIQ_NOTIFICATIONS_INTERVAL_MS",
  "CODIQ_VISIT_FLUSH_MS",
  "CODIQ_SHUTDOWN_GRACE_MS",
  "SENTRY_DSN",
] as const;

type PassthroughName = (typeof PASSTHROUGH)[number];

export interface Env extends Partial<Record<PassthroughName, string>> {
  PLATFORM: DurableObjectNamespace<PlatformContainer>;
  /** How many instances requests are spread across. Must not exceed `max_instances`. */
  INSTANCES?: string;
}

function containerEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = { PORT: "3000" };
  for (const name of PASSTHROUGH) {
    const value = env[name];
    if (typeof value === "string" && value !== "") out[name] = value;
  }
  return out;
}

export class PlatformContainer extends Container<Env> {
  defaultPort = 3000;
  /**
   * Idle instances stop after this long. The cron below keeps instance-0 awake,
   * so its notification worker keeps draining the outbox and retries on time.
   */
  sleepAfter = "15m";
  /** The app has no `/ping`; `/api/health` answers as soon as the process listens. */
  pingEndpoint = "localhost/api/health";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = containerEnv(env);
  }
}

function instanceCount(env: Env): number {
  const parsed = Number(env.INSTANCES ?? 2);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 2;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const instance = await getRandom(env.PLATFORM, instanceCount(env));
    return instance.fetch(request);
  },

  /**
   * Every five minutes: wake (or keep awake) instance-0. A request renews the
   * container's activity, so with `sleepAfter = 15m` it never sleeps, and the
   * notification worker inside it is always running. `/api/ready` also checks
   * the database, so a failure shows up in the Worker's logs.
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const primary = getContainer(env.PLATFORM, "instance-0");
    ctx.waitUntil(
      primary.fetch(new Request("http://localhost/api/ready")).then(async (response) => {
        if (!response.ok) console.error(`keep-warm: /api/ready answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
