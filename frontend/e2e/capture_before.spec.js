import { test } from '@playwright/test';

const VIEWPORTS = [
  { name: '320', width: 320, height: 640 },
  { name: '360', width: 360, height: 740 },
  { name: '390', width: 390, height: 844 },
  { name: '768', width: 768, height: 1024 },
  { name: '1024', width: 1024, height: 768 }
];

test.describe('Capture BEFORE Screenshots', () => {
  for (const vp of VIEWPORTS) {
    test(`Capture all screens @ ${vp.name}px`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        baseURL: 'http://localhost:3000'
      });
      const page = await context.newPage();

      // 1. Login Page
      await page.goto('/');
      await page.waitForTimeout(500);
      await page.screenshot({ path: `../tests/screenshots/before/login-${vp.name}.png`, fullPage: true });

      // 2. Owner Auth Modal
      await page.goto('/?portal=owner');
      await page.waitForTimeout(500);
      await page.screenshot({ path: `../tests/screenshots/before/owner-auth-${vp.name}.png`, fullPage: true });

      // 3. Public Verify Page
      await page.goto('/verify?ledgerHash=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
      await page.waitForTimeout(500);
      await page.screenshot({ path: `../tests/screenshots/before/public-verify-${vp.name}.png`, fullPage: true });

      // 4. Authenticate as Doctor (Emily Chen)
      await page.goto('/');
      const emailInput = page.locator('input[type="email"]');
      if (await emailInput.isVisible().catch(() => false)) {
        await emailInput.fill('emily.chen@petcare.vet');
        await page.locator('input[type="password"]').fill('Password123!');
        await page.locator('button:has-text("Sign In")').click();
        await page.waitForTimeout(1500);
      }

      // 5. Consultation Tab
      await page.goto('/?tab=consultation');
      await page.waitForTimeout(800);
      await page.screenshot({ path: `../tests/screenshots/before/consultation-${vp.name}.png`, fullPage: true });

      // 6. Directory / Patients Tab
      await page.goto('/?tab=patients');
      await page.waitForTimeout(800);
      await page.screenshot({ path: `../tests/screenshots/before/directory-${vp.name}.png`, fullPage: true });

      // 7. Scheduling / Calendar Tab
      await page.goto('/?tab=schedule');
      await page.waitForTimeout(800);
      await page.screenshot({ path: `../tests/screenshots/before/scheduling-${vp.name}.png`, fullPage: true });

      // 8. Doctor Settings Tab
      await page.goto('/?tab=settings');
      await page.waitForTimeout(800);
      await page.screenshot({ path: `../tests/screenshots/before/settings-${vp.name}.png`, fullPage: true });

      // 9. Doctor Audit Log Tab
      await page.goto('/?tab=audit');
      await page.waitForTimeout(800);
      await page.screenshot({ path: `../tests/screenshots/before/audit-${vp.name}.png`, fullPage: true });

      // 10. Owner Portal (Authenticated with mock session)
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
      await page.screenshot({ path: `../tests/screenshots/before/owner-portal-${vp.name}.png`, fullPage: true });

      // 11. Super Admin View (Simulate super_admin role)
      await page.evaluate(() => {
        localStorage.removeItem('petcare_owner_session');
      });
      // Switch to super_admin or admin
      await context.close();
    });
  }
});
