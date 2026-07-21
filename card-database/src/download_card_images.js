const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const cardsRepo = require('./models/cards');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT_DIR = path.join(ROOT_DIR, 'card-images');
const VALID_VARIANTS = new Set(['original', 'small', 'cropped', 'all']);

function parseArgs(argv) {
  const args = {
    outputDir: DEFAULT_OUTPUT_DIR,
    variant: 'original',
    concurrency: 8,
    overwrite: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--output') {
      const next = argv[index + 1];
      if (!next) throw new Error('--output requires a folder path');
      args.outputDir = path.resolve(process.cwd(), next);
      index += 1;
      continue;
    }

    if (token === '--variant') {
      const next = argv[index + 1];
      if (!next || !VALID_VARIANTS.has(next)) {
        throw new Error('--variant must be one of: original, small, cropped, all');
      }
      args.variant = next;
      index += 1;
      continue;
    }

    if (token === '--concurrency') {
      const next = Number(argv[index + 1]);
      if (!Number.isInteger(next) || next < 1 || next > 32) {
        throw new Error('--concurrency must be an integer between 1 and 32');
      }
      args.concurrency = next;
      index += 1;
      continue;
    }

    if (token === '--overwrite') {
      args.overwrite = true;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function extensionFromUrl(url) {
  try {
    const parsed = new URL(url);
    const ext = path.extname(parsed.pathname);
    return ext || '.jpg';
  } catch {
    return '.jpg';
  }
}

function toVariantSources(image, variant) {
  const variants = [];

  if (variant === 'original' || variant === 'all') {
    variants.push({ url: image.imageUrl, suffix: '' });
  }
  if (variant === 'small' || variant === 'all') {
    variants.push({ url: image.imageUrlSmall, suffix: '_small' });
  }
  if (variant === 'cropped' || variant === 'all') {
    variants.push({ url: image.imageUrlCropped, suffix: '_cropped' });
  }

  return variants;
}

function collectImageTasks(variant, outputDir) {
  const tasks = [];
  const uniqueNames = new Set();
  const cards = cardsRepo.allImages();

  for (const card of cards) {
    for (const image of card.images || []) {
      for (const source of toVariantSources(image, variant)) {
        if (!source.url) continue;

        const ext = extensionFromUrl(source.url);
        const fileName = `${image.imageId}${source.suffix}${ext}`;

        if (uniqueNames.has(fileName)) continue;
        uniqueNames.add(fileName);
        tasks.push({ url: source.url, filePath: path.join(outputDir, fileName) });
      }
    }
  }

  return { tasks, cardsScanned: cards.length };
}

async function downloadOne(url, filePath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!response.body) throw new Error('Empty response body');

  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tmpPath));
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    throw error;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadWithRetries(url, filePath, attempts = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await downloadOne(url, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(attempt * 500);
    }
  }

  throw lastError;
}

async function runWithConcurrency(items, concurrency, worker) {
  let currentIndex = 0;

  async function next() {
    if (currentIndex >= items.length) return;
    const itemIndex = currentIndex;
    currentIndex += 1;
    await worker(items[itemIndex], itemIndex);
    await next();
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => next());
  await Promise.all(workers);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const { tasks, cardsScanned } = collectImageTasks(args.variant, args.outputDir);

  if (cardsScanned === 0) {
    throw new Error('No cards found in the local database. Run `npm run cards:import` first.');
  }

  if (tasks.length === 0) {
    console.log('No image URLs found for the selected variant.');
    return;
  }

  fs.mkdirSync(args.outputDir, { recursive: true });

  const stats = { downloaded: 0, skipped: 0, failed: 0 };

  console.log(
    `Starting download of ${tasks.length} images to ${args.outputDir} `
    + `(variant=${args.variant}, concurrency=${args.concurrency})`
  );

  await runWithConcurrency(tasks, args.concurrency, async (task, index) => {
    if (!args.overwrite && fs.existsSync(task.filePath)) {
      stats.skipped += 1;
    } else {
      try {
        await downloadWithRetries(task.url, task.filePath);
        stats.downloaded += 1;
      } catch (error) {
        stats.failed += 1;
        console.error(`Failed: ${task.url} -> ${error.message}`);
      }
    }

    const processed = index + 1;
    if (processed % 500 === 0 || processed === tasks.length) {
      console.log(
        `Progress ${processed}/${tasks.length} | `
        + `downloaded=${stats.downloaded} skipped=${stats.skipped} failed=${stats.failed}`
      );
    }
  });

  console.log(`Done. Downloaded=${stats.downloaded}, skipped=${stats.skipped}, failed=${stats.failed}.`);
}

run().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
