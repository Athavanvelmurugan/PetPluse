import { test } from '@playwright/test';

const AFTER_VIEWPORTS = [
  { name: '360', width: 360, height: 740 },
  { name: '768', width: 768, height: 1024 },
  { name: '1280', width: 1280, height: 800 }
];

test.describe('Capture AFTER Screenshots (Steps 2 & 3 Foundations & Navigation)', () => {
  for (const vp of AFTER_VIEWPORTS) {
    test(`Capture AFTER screens @ ${vp.name}px`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        baseURL: 'http://localhost:3000'
      });
      const page = await context.newPage();

      // 1. Login Page
      await page.goto('/');
      await page.waitForTimeout(500);
      await page.screenshot({ path: `../tests/screenshots/after/login-${vp.name}.png`, fullPage: true });

      // 2. Public Verify Page
      await page.goto('/verify?ledgerHash=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
      await page.waitForTimeout(500);
      await page.screenshot({ path: `../tests/screenshots/after/public-verify-${vp.name}.png`, fullPage: true });

      // 3. Authenticate as Doctor (Emily Chen)
      await page.goto('/');
      const emailInput = page.locator('input[type="email"]');
      if (await emailInput.isVisible().catch(() => false)) {
        await emailInput.fill('emily.chen@petcare.vet');
        await page.locator('input[type="password"]').fill('Password123!');
        await page.locator('button:has-text("Sign In")').click();
        await page.waitForTimeout(1500);
      }

      // 4. Consultation Tab
      await page.goto('/?tab=consultation');
      await page.waitForTimeout(800);
      await page.screenshot({ path: `../tests/screenshots/after/consultation-${vp.name}.png`, fullPage: true });

      // 5. Patient Directory Tab
      await page.goto('/?tab=patients');
      await page.waitForTimeout(800);
      await page.screenshot({ path: `../tests/screenshots/after/directory-${vp.name}.png`, fullPage: true });

      // 6. Scheduling / Calendar Tab
      await page.goto('/?tab=schedule');
      await page.waitForTimeout(800);
      await page.screenshot({ path: `../tests/screenshots/after/scheduling-${vp.name}.png`, fullPage: true });

      // 7. Audit Log Tab
      await page.goto('/?tab=audit');
      await page.waitForTimeout(800);
      await page.screenshot({ path: `../tests/screenshots/after/audit-${vp.name}.png`, fullPage: true });

      // 8. Doctor Settings Tab
      await page.goto('/?tab=settings');
      await page.waitForTimeout(800);
      await page.screenshot({ path: `../tests/screenshots/after/settings-${vp.name}.png`, fullPage: true });

      // 9. Owner Portal (Authenticated)
      await page.evaluate(() => {
        localStorage.setItem('petcare_owner_session', JSON.stringify({
          id: 1,
          name: 'Sarah Jenkins',
          phone: '+15551234567',
          pets: [{ id: 1, name: 'Max', species: 'Canine', breed: 'Golden Retriever', age: 4 }]
        }));
      });
      await page.goto('/?portal=owner');
      await page.waitForTimeout(800);
      await page.screenshot({ path: `../tests/screenshots/after/owner-portal-${vp.name}.png`, fullPage: true });

      await context.close();
    });
  }
});

