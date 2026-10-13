/**
 * The frozen `web/convex/email_actions.ts` templates + `renderTemplate`, ported
 * verbatim into the Nest module. `web/convex/**` is read-only (Rule 10), so this
 * is a copy of the markup, not an import.
 *
 * The frozen `renderTemplate` fell back to `welcome` for an **unknown** template
 * name. The Nest port keeps the same renderer but the service validates the name
 * against {@link EMAIL_TEMPLATE_KEYS} first and rejects an unknown template — or
 * an unknown key — with a 400 (ADR-010, DEV-006 class). Only the five templates
 * that ever carried body markup are defined here; `comment_alert` and
 * `new_article` rows enqueued by Phases 06/05 render through their own key set
 * and the freeze-in-place fallback.
 */

/** The allowed keys each template interpolates. Unknown → 400 (DEV-006). */
export const EMAIL_TEMPLATE_KEYS: Readonly<Record<string, readonly string[]>> = {
  welcome: ['name', 'siteUrl', 'unsubscribeUrl'],
  newsletter: [
    'name',
    'articlesHtml',
    'quoteText',
    'quoteAuthor',
    'siteUrl',
    'unsubscribeUrl',
  ],
  confirm_subscription: ['confirmUrl'],
  reset_password: ['resetUrl', 'siteUrl'],
  otp_verification: ['otpCode', 'siteUrl'],
  comment_alert: ['commenterName', 'articleTitle', 'commentContent', 'adminUrl'],
  new_article: [
    'articleTitle',
    'excerpt',
    'articleUrl',
    'authorName',
    'categoryName',
    'unsubscribeUrl',
  ],
};

export const EMAIL_TEMPLATES: Readonly<Record<string, string>> = {
  welcome: `
    <div style="font-family: 'Inter', system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #f1f5f9; border-radius: 32px; overflow: hidden; box-shadow: 0 40px 100px -20px rgba(0, 0, 0, 0.1);">
      <div style="background: #09090b; padding: 80px 40px; text-align: center; position: relative;">
        <img src="{{siteUrl}}/illustrations/Welcome.svg" alt="Welcome Illustration" style="width: 240px; height: auto; margin-bottom: 40px; opacity: 1; display: block; margin-left: auto; margin-right: auto;" />
        <h1 style="color: white; margin: 0; font-family: 'Georgia', serif; font-size: 36px; letter-spacing: -0.03em; line-height: 1.2;">Welcome to the <span style="color: #2563eb;">Inner Circle</span>.</h1>
        <p style="color: #a1a1aa; font-size: 14px; margin-top: 16px; text-transform: uppercase; letter-spacing: 0.3em; font-weight: 900;">Initiation Protocol Complete</p>
      </div>
      <div style="padding: 60px 50px; color: #09090b; line-height: 1.8;">
        <h2 style="font-size: 24px; font-weight: 900; margin-bottom: 24px;">Reality starts here, {{name}}.</h2>
        <p style="font-size: 16px; color: #4b5563; margin-bottom: 24px;">
          You've just taken the first step toward unfiltered reality. <strong>The Truth Pill</strong> is not just a publication; it&apos;s a recalibration of the human experience.
        </p>
        <p style="font-size: 16px; color: #4b5563; margin-bottom: 48px;">
          Expect insights that stir the mind and research that challenges the comfortable lies of modern existence.
        </p>
        <div style="text-align: center; margin-bottom: 60px;">
          <a href="{{siteUrl}}" style="background: #2563eb; color: white; padding: 22px 44px; border-radius: 20px; text-decoration: none; font-weight: 900; font-size: 15px; text-transform: uppercase; letter-spacing: 0.15em; display: inline-block; box-shadow: 0 20px 30px -10px rgba(37, 99, 235, 0.4);">Access Your Dashboard</a>
        </div>
        <div style="border-top: 1px solid #f1f5f9; padding-top: 40px;">
          <p style="font-size: 14px; color: #94a3b8; margin: 0;">In pursuit of truth,</p>
          <p style="font-size: 16px; font-weight: 900; color: #09090b; margin: 8px 0 0 0;">The Truth Pill Editorial</p>
        </div>
      </div>
      <div style="background: #f8fafc; padding: 48px; text-align: center; border-top: 1px solid #f1f5f9;">
        <p style="font-size: 12px; color: #94a3b8; margin: 0 0 20px 0;">&copy; 2026 The Truth Pill. Evolution is mandatory.</p>
        <div style="display: inline-block;">
          <a href="{{unsubscribeUrl}}" style="color: #2563eb; text-decoration: none; font-size: 11px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.1em; border-bottom: 2px solid #dbeafe;">Silence these signals</a>
        </div>
      </div>
    </div>
  `,
  newsletter: `
    <div style="font-family: 'Inter', sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #f1f5f9; border-radius: 32px; overflow: hidden; box-shadow: 0 40px 100px -20px rgba(0, 0, 0, 0.08);">
      <div style="background: #09090b; padding: 48px; text-align: center; position: relative;">
        <img src="{{siteUrl}}/illustrations/Newsletter.svg" alt="Newsletter Illustration" style="width: 180px; height: auto; margin-bottom: 32px; opacity: 1;" />
        <h1 style="color: white; margin: 0; font-family: 'Georgia', serif; font-size: 28px;">Weekly Transmission</h1>
        <p style="color: #2563eb; font-size: 12px; margin-top: 12px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.4em;">The Observational Pulse</p>
      </div>
      <div style="padding: 50px;">
        <div style="background: #f8fafc; border-radius: 28px; padding: 40px; margin-bottom: 48px; border: 2px solid #eff6ff; position: relative;">
          <p style="margin: 0; font-family: 'Georgia', serif; font-style: italic; color: #0f172a; font-size: 20px; line-height: 1.7; position: relative; z-index: 10;">"{{quoteText}}"</p>
          <p style="margin: 24px 0 0 0; color: #2563eb; font-size: 13px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.2em;">— {{quoteAuthor}}</p>
        </div>
        
        <div style="margin-bottom: 40px;">
          <h3 style="font-size: 12px; font-weight: 900; color: #64748b; text-transform: uppercase; letter-spacing: 0.3em; margin-bottom: 32px; border-bottom: 1px solid #f1f5f9; padding-bottom: 12px;">Top Intelligence Nodes</h3>
          {{articlesHtml}}
        </div>
        
        <div style="text-align: center; margin-top: 60px;">
          <a href="{{siteUrl}}" style="background: #09090b; color: white; padding: 20px 48px; border-radius: 18px; text-decoration: none; font-weight: 900; font-size: 14px; text-transform: uppercase; letter-spacing: 0.15em; display: inline-block;">Return to Source</a>
        </div>
      </div>
      <div style="background: #f8fafc; padding: 40px; text-align: center; border-top: 1px solid #f1f5f9;">
        <p style="font-size: 11px; color: #94a3b8; margin-bottom: 12px;">&copy; 2026 The Truth Pill. Deciphering the Human Experience.</p>
        <a href="{{unsubscribeUrl}}" style="color: #64748b; text-decoration: none; font-size: 10px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.1em;">Unsubscribe</a>
      </div>
    </div>
  `,
  confirm_subscription: `
    <div style="font-family: 'Inter', sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #f1f5f9; border-radius: 32px; overflow: hidden; box-shadow: 0 40px 100px -20px rgba(0, 0, 0, 0.05);">
      <div style="padding: 80px 50px; text-align: center;">
        <img src="{{siteUrl}}/illustrations/Messaging.svg" alt="Confirm Illustration" style="width: 200px; height: auto; margin-bottom: 48px; opacity: 1;" />
        <h1 style="font-size: 32px; font-weight: 900; color: #09090b; margin-bottom: 16px; letter-spacing: -0.02em;">Verify Connection</h1>
        <p style="color: #64748b; font-size: 17px; line-height: 1.7; margin-bottom: 40px; max-width: 400px; margin-left: auto; margin-right: auto;">
          You&apos;re one step away from joining <strong>The Truth Pill</strong>. Please confirm your subscription to activate our intelligence stream.
        </p>
        <a href="{{confirmUrl}}" style="background: #2563eb; color: white; padding: 20px 48px; border-radius: 18px; text-decoration: none; font-weight: 900; font-size: 14px; text-transform: uppercase; letter-spacing: 0.2em; display: inline-block; shadow: 0 10px 20px rgba(37, 99, 235, 0.3);">Confirm Subscription</a>
        <p style="margin-top: 48px; font-size: 13px; color: #94a3b8;">If you did not initiate this protocol, please ignore this transmission.</p>
      </div>
    </div>
  `,
  reset_password: `
    <div style="font-family: 'Inter', sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #f1f5f9; border-radius: 32px; overflow: hidden;">
      <div style="padding: 80px 50px; text-align: center;">
        <img src="{{siteUrl}}/illustrations/Secure-login.svg" alt="Reset Illustration" style="width: 200px; height: auto; margin-bottom: 48px; opacity: 1;" />
        <h1 style="font-size: 32px; font-weight: 900; color: #09090b; margin-bottom: 16px; letter-spacing: -0.02em;">Identity Reset</h1>
        <p style="color: #64748b; font-size: 17px; line-height: 1.7; margin-bottom: 40px; max-width: 400px; margin-left: auto; margin-right: auto;">
          An identity reset for <strong>The Truth Pill</strong> was requested. This secure link will remain active for 60 minutes.
        </p>
        <a href="{{resetUrl}}" style="background: #09090b; color: white; padding: 20px 48px; border-radius: 18px; text-decoration: none; font-weight: 900; font-size: 14px; text-transform: uppercase; letter-spacing: 0.2em; display: inline-block;">Reset Password</a>
        <p style="margin-top: 48px; font-size: 13px; color: #94a3b8;">If you did not authorize this recalibration, secure your account immediately.</p>
      </div>
    </div>
  `,
  otp_verification: `
    <div style="font-family: 'Inter', system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #f1f5f9; border-radius: 32px; overflow: hidden; box-shadow: 0 40px 100px -20px rgba(0, 0, 0, 0.1);">
      <div style="background: #09090b; padding: 60px 40px; text-align: center;">
        <h1 style="color: white; margin: 0; font-family: 'Georgia', serif; font-size: 32px; letter-spacing: -0.03em;">Verification Code</h1>
        <p style="color: #a1a1aa; font-size: 12px; margin-top: 12px; text-transform: uppercase; letter-spacing: 0.3em; font-weight: 900;">Security Protocol</p>
      </div>
      <div style="padding: 60px 50px; text-align: center; color: #09090b;">
        <p style="font-size: 16px; color: #4b5563; margin-bottom: 40px;">
          Use the following code to complete your security protocol. This code will expire in 10 minutes.
        </p>
        <div style="background: #f1f5f9; border-radius: 20px; padding: 32px; display: inline-block; margin-bottom: 40px; border: 2px solid #e2e8f0;">
          <span style="font-size: 42px; font-weight: 900; color: #2563eb; letter-spacing: 0.25em; font-family: 'Courier New', monospace;">{{otpCode}}</span>
        </div>
        <p style="font-size: 14px; color: #94a3b8; margin-top: 40px;">
          If you did not request this code, please secure your account immediately.
        </p>
      </div>
      <div style="background: #f8fafc; padding: 32px; text-align: center; border-top: 1px solid #f1f5f9;">
        <p style="font-size: 12px; color: #94a3b8; margin: 0;">&copy; 2026 The Truth Pill. Evolution is mandatory.</p>
      </div>
    </div>
  `,
};

/** Interpolate `{{key}}` placeholders (frozen `renderTemplate`, `email_actions.ts:140`). */
export function renderTemplate(
  name: string,
  data: Record<string, string>,
): string {
  let html = EMAIL_TEMPLATES[name] ?? EMAIL_TEMPLATES.welcome;
  for (const [key, value] of Object.entries(data)) {
    html = html.replace(new RegExp(`{{${key}}}`, 'g'), value);
  }
  return html;
}
