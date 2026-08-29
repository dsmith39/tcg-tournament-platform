// Verifies deep-link load of decklists with authenticated localStorage state.
const { expect, test } = require('@playwright/test');
const { installMockApi } = require('./helpers/mock-api');

test('decklists page loads and shows saved decklists', async ({ page }) => {
  await installMockApi(page);
  await page.addInitScript(() => {
    window.localStorage.setItem('token', 'playwright-token');
  });

  await page.goto('/decklists');
  await expect(page).toHaveURL(/\/decklists$/);
  await expect(page.getByRole('heading', { name: 'My Decklists' })).toBeVisible();
  await expect(page.getByText('Starter Deck')).toBeVisible();
});

test('decklist form reveals the skill picker only for Duel Links', async ({ page }) => {
  await installMockApi(page);
  await page.addInitScript(() => {
    window.localStorage.setItem('token', 'playwright-token');
  });

  await page.goto('/decklists');
  await page.getByRole('button', { name: '+ New Decklist' }).click();

  const skillsGroup = page.locator('#decklist-skills-group');
  await expect(skillsGroup).toBeHidden();

  await page.selectOption('#decklist-game', 'ygo-tcg');
  await expect(skillsGroup).toBeHidden();

  await page.selectOption('#decklist-game', 'duel-links');
  await expect(skillsGroup).toBeVisible();

  await page.fill('#deck-skill-name', 'Balance');
  await page.getByRole('button', { name: '+ Add Skill' }).click();
  await expect(page.locator('#deck-builder-skills')).toContainText('Balance');
  await expect(page.locator('#deck-count-skills')).toHaveText('1');

  // Switching back to a game without skills drops what was entered, so the form
  // never shows one thing while saving another.
  await page.selectOption('#decklist-game', 'master-duel');
  await expect(skillsGroup).toBeHidden();
  await page.selectOption('#decklist-game', 'duel-links');
  await expect(page.locator('#deck-count-skills')).toHaveText('0');
});

test('saved Duel Links decklist shows its skill', async ({ page }) => {
  await installMockApi(page);
  await page.addInitScript(() => {
    window.localStorage.setItem('token', 'playwright-token');
  });

  await page.goto('/decklists/507f1f77bcf86cd799439012');
  await expect(page.getByRole('heading', { name: 'Links Beatdown' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Skill', exact: true })).toBeVisible();
  await expect(page.getByText('Balance')).toBeVisible();
});
