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
  await page.locator('#decklist-name').click();

  // Switching back to a game without skills drops what was entered, so the form
  // never shows one thing while saving another.
  await page.selectOption('#decklist-game', 'master-duel');
  await expect(skillsGroup).toBeHidden();
  await page.selectOption('#decklist-game', 'duel-links');
  await expect(page.locator('#deck-count-skills')).toHaveText('0');
});

// The skills endpoint is deliberately left unmocked so this exercises the real
// catalog the server ships, not a fixture that could drift from it.
test('skill picker autocompletes against the full Duel Links catalog', async ({ page }) => {
  await installMockApi(page);
  await page.addInitScript(() => {
    window.localStorage.setItem('token', 'playwright-token');
  });

  await page.goto('/decklists');
  await page.getByRole('button', { name: '+ New Decklist' }).click();
  await page.selectOption('#decklist-game', 'duel-links');

  const suggestions = page.locator('#deck-skill-suggestions');

  // A skill that was never in the old hand-written list -- proof the picker is
  // reading the imported catalog rather than a hardcoded subset.
  await page.fill('#deck-skill-name', 'Sorcery Conduit');
  await expect(suggestions.getByRole('button').first()).toContainText('Sorcery Conduit');

  // Partial, mid-name matches resolve too.
  await page.fill('#deck-skill-name', 'draw sense');
  await expect(suggestions.getByRole('button').first()).toContainText('Draw Sense');
  const suggestionCount = await suggestions.getByRole('button').count();
  expect(suggestionCount).toBeGreaterThan(1);

  // Clicking a suggestion adds it without needing the Add button.
  await suggestions.getByRole('button').first().click();
  await expect(page.locator('#deck-count-skills')).toHaveText('1');
  await expect(page.locator('#deck-builder-skills')).toContainText('Draw Sense');
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
