#!/usr/bin/env node

/**
 * link-documents.js
 *
 * Copia los documentos fuente (PDFs) e imagenes de cada carpeta de nota
 * a la carpeta public/ del sitio, y agrega enlaces de descarga en cada .md.
 *
 * Uso:
 *   node scripts/link-documents.js <carpeta-con-notas>
 *   node scripts/link-documents.js ~/Downloads/notas
 */

import { readdir, readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { join, resolve, basename, extname } from 'node:path';
import { existsSync } from 'node:fs';

const NOTAS_DIR = join(process.cwd(), 'src/content/notas');
const PUBLIC_DOCS_DIR = join(process.cwd(), 'public/documents');
const PUBLIC_IMAGES_DIR = join(process.cwd(), 'public/images');

// ─── Helpers ────────────────────────────────────────────────────

function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

// Score how well two slugs match (0-1)
function matchScore(a, b) {
  if (a === b) return 1;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  if (longer.includes(shorter)) return shorter.length / longer.length;

  // Count common 4-grams
  const ngrams = (s, n) => Array.from({ length: s.length - n + 1 }, (_, i) => s.slice(i, i + n));
  const gA = new Set(ngrams(a, 4));
  const gB = new Set(ngrams(b, 4));
  const common = [...gA].filter(g => gB.has(g)).length;
  return (2 * common) / (gA.size + gB.size + 1);
}

function safeName(name) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._\-]/g, '_')
    .replace(/_+/g, '_');
}

async function findFiles(dir, extensions) {
  const results = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const subResults = await findFiles(fullPath, extensions);
        results.push(...subResults);
      } else if (extensions.includes(extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
  } catch {}
  return results;
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Uso: node scripts/link-documents.js <carpeta-con-subcarpetas-de-notas>');
    console.error('Ejemplo: node scripts/link-documents.js ~/Downloads/notas');
    process.exit(1);
  }

  const sourceDir = resolve(args[0]);
  console.log(`\nLeyendo carpeta: ${sourceDir}`);

  // Read existing .md note slugs
  const mdFiles = (await readdir(NOTAS_DIR)).filter(f => f.endsWith('.md'));
  const notaSlugs = mdFiles.map(f => f.replace('.md', ''));
  console.log(`Notas existentes: ${notaSlugs.length}`);

  // Read subdirectories in sourceDir (each one = a nota's documents)
  const sourceEntries = await readdir(sourceDir, { withFileTypes: true });
  const sourceFolders = sourceEntries.filter(e => e.isDirectory()).map(e => e.name);
  console.log(`Carpetas de documentos: ${sourceFolders.length}\n`);

  await mkdir(PUBLIC_DOCS_DIR, { recursive: true });
  await mkdir(PUBLIC_IMAGES_DIR, { recursive: true });

  let totalPdfs = 0;
  let totalImages = 0;
  let totalUpdated = 0;

  for (const folder of sourceFolders) {
    const folderSlug = slugify(folder);
    const folderPath = join(sourceDir, folder);

    // Find matching nota slug
    let bestSlug = null;
    let bestScore = 0;
    for (const notaSlug of notaSlugs) {
      const score = matchScore(folderSlug, notaSlug);
      if (score > bestScore) {
        bestScore = score;
        bestSlug = notaSlug;
      }
    }

    if (!bestSlug || bestScore < 0.25) {
      console.log(`  [sin match] "${folder}" (score: ${bestScore.toFixed(2)})`);
      continue;
    }

    console.log(`  "${folder}"`);
    console.log(`    → ${bestSlug} (score: ${bestScore.toFixed(2)})`);

    // Find PDFs and images
    const pdfs = await findFiles(folderPath, ['.pdf']);
    const images = await findFiles(folderPath, ['.png', '.jpg', '.jpeg', '.webp']);

    if (pdfs.length === 0 && images.length === 0) {
      console.log(`    (sin archivos relevantes)`);
      continue;
    }

    // Copy PDFs
    const docLinks = [];
    if (pdfs.length > 0) {
      const destDocDir = join(PUBLIC_DOCS_DIR, bestSlug);
      await mkdir(destDocDir, { recursive: true });

      for (const pdfPath of pdfs) {
        const fileName = safeName(basename(pdfPath));
        const destPath = join(destDocDir, fileName);
        await copyFile(pdfPath, destPath);
        docLinks.push({ name: basename(pdfPath).replace(/\.pdf$/i, ''), path: `/documents/${bestSlug}/${fileName}` });
        totalPdfs++;
      }
      console.log(`    PDFs copiados: ${pdfs.length}`);
    }

    // Copy images
    let firstImagePath = '';
    if (images.length > 0) {
      const destImgDir = join(PUBLIC_IMAGES_DIR, bestSlug);
      await mkdir(destImgDir, { recursive: true });

      for (let i = 0; i < images.length; i++) {
        const imgPath = images[i];
        const fileName = safeName(basename(imgPath));
        const destPath = join(destImgDir, fileName);
        await copyFile(imgPath, destPath);
        if (i === 0) firstImagePath = `/images/${bestSlug}/${fileName}`;
        totalImages++;
      }
      console.log(`    Imagenes copiadas: ${images.length}`);
    }

    // Update the .md file
    const mdPath = join(NOTAS_DIR, `${bestSlug}.md`);
    let mdContent = await readFile(mdPath, 'utf-8');

    // Update image field if we have images and it's currently empty
    if (firstImagePath && mdContent.includes('image: ""')) {
      mdContent = mdContent.replace('image: ""', `image: "${firstImagePath}"`);
    }

    // Add documents section if we have PDFs and it's not already there
    if (docLinks.length > 0 && !mdContent.includes('## Documentos')) {
      const docsSection = `\n\n---\n\n## Documentos fuente\n\n${docLinks.map(d =>
        `- [${d.name}](${d.path})`
      ).join('\n')}\n`;
      mdContent = mdContent.trimEnd() + docsSection;
    }

    await writeFile(mdPath, mdContent, 'utf-8');
    totalUpdated++;
    console.log(`    Nota actualizada: ${bestSlug}.md`);
  }

  console.log(`\n─────────────────────────────────`);
  console.log(`Notas actualizadas: ${totalUpdated}`);
  console.log(`PDFs copiados: ${totalPdfs}`);
  console.log(`Imagenes copiadas: ${totalImages}`);
  console.log(`\nUbicacion de archivos:`);
  console.log(`  PDFs:    public/documents/[slug]/`);
  console.log(`  Imagenes: public/images/[slug]/\n`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
