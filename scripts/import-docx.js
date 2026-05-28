#!/usr/bin/env node

/**
 * import-docx.js
 *
 * Convierte un archivo .docx con multiples notas en archivos .md individuales.
 *
 * Uso:
 *   node scripts/import-docx.js ruta/al/archivo.docx
 *   npm run import -- ruta/al/archivo.docx
 *
 * Estructura esperada del .docx:
 *   [Tag del demandado]
 *   # Titulo de la nota
 *   Cuerpo de la nota...
 *   [Siguiente tag]
 *   # Siguiente titulo
 *   ...
 */

import mammoth from 'mammoth';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// ─── Configuration ──────────────────────────────────────────────

const OUTPUT_DIR = join(process.cwd(), 'src/content/notas');
const PLACEHOLDER_DATE = '2025-01-01';

const CATEGORIES = [
  'Acceso a la informacion',
  'Gasto publico',
  'Causa colectiva',
  'Transparencia',
];

// Keywords for category inference
const CATEGORY_KEYWORDS = {
  'Gasto publico': [
    'contrato', 'concesion', 'canon', 'licitacion', 'presupuesto',
    'gasto', 'costo', 'factur', 'pago', 'millones', 'precio',
    'adjudic', 'compra', 'patrimoni'
  ],
  'Causa colectiva': [
    'causa colectiva', 'accion colectiva', 'amparo colectivo',
    'clase', 'colectivo', 'consumidor', 'usuario', 'afectados',
    'demanda colectiva'
  ],
  'Transparencia': [
    'transparencia', 'rendicion de cuentas', 'gobierno abierto',
    'datos abiertos', 'open data', 'accountability'
  ],
  'Acceso a la informacion': [
    'acceso a la informacion', 'pedido de informacion', 'ley 104',
    'ley 27275', 'denegatoria', 'silencio', 'amparo por acceso',
    'derecho a la informacion', 'informacion publica'
  ],
};

// Tags/entities to skip (not real demandado tags)
const SKIP_TAGS = [
  'pendientes', 'pendiente', 'notas', 'indice', 'index',
  'tabla de contenidos', 'contenidos', 'borrador', 'draft',
  'todo', 'ideas',
];

// ─── Helpers ────────────────────────────────────────────────────

function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove diacritics
    .replace(/[^a-z0-9\s-]/g, '')   // remove special chars
    .replace(/\s+/g, '-')           // spaces to hyphens
    .replace(/-+/g, '-')            // collapse hyphens
    .replace(/^-|-$/g, '')          // trim hyphens
    .slice(0, 80);                  // limit length
}

function stripMarkdown(text) {
  return text
    .replace(/\\([.()!\[\]\-*_#`~>|{}])/g, '$1') // unescape backslashes
    .replace(/_{2,3}([^_]+)_{2,3}/g, '$1')         // __bold__ / ___bold___
    .replace(/\*{2,3}([^*]+)\*{2,3}/g, '$1')        // **bold** / ***bold***
    .replace(/_([^_]+)_/g, '$1')                    // _italic_
    .replace(/\*([^*]+)\*/g, '$1')                  // *italic*
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')        // [link](url) → link
    .replace(/<[^>]+>/g, '')                         // HTML tags
    .replace(/^#+\s+/gm, '')                         // heading markers
    .replace(/^[-*]\s+/gm, '')                       // list markers
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSummary(body) {
  // Get first ~2 sentences from the body text (ignoring headers, lists, etc.)
  const lines = body.split('\n').filter(line => {
    const trimmed = line.trim();
    return trimmed &&
      !trimmed.startsWith('#') &&
      !trimmed.startsWith('-') &&
      !trimmed.startsWith('*') &&
      !trimmed.startsWith('>') &&
      !trimmed.startsWith('[') &&
      !trimmed.startsWith('!');
  });

  const raw = lines.join(' ').trim();
  const text = stripMarkdown(raw);

  // Split by sentence-ending punctuation
  const sentences = text.match(/[^.!?]+[.!?]+/g);
  if (!sentences) return text.slice(0, 200);

  const summary = sentences.slice(0, 2).join(' ').trim();
  return summary.length > 300 ? summary.slice(0, 297) + '...' : summary;
}

function inferCategory(title, body) {
  const text = (title + ' ' + body).toLowerCase();

  // Check each category's keywords (in priority order)
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const kw of keywords) {
      if (text.includes(kw)) {
        return category;
      }
    }
  }

  return 'Acceso a la informacion'; // default
}

function isLikelyTag(line) {
  const trimmed = line.trim();

  // Must be short (tags are usually 1-4 words)
  if (trimmed.length > 60) return false;
  if (trimmed.length < 2) return false;

  // Should NOT be a heading, list item, paragraph, etc.
  if (trimmed.startsWith('#')) return false;
  if (trimmed.startsWith('-') || trimmed.startsWith('*')) return false;
  if (trimmed.startsWith('>')) return false;

  // Should not be a long sentence (heuristic: no more than 5 words)
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount > 6) return false;

  // Should not be in skip list
  if (SKIP_TAGS.includes(trimmed.toLowerCase())) return false;

  // Should start with uppercase (entity name)
  if (!/^[A-ZÁÉÍÓÚÑ]/.test(trimmed)) return false;

  return true;
}

function isSkippableSection(title) {
  const lower = title.toLowerCase();
  return lower.includes('pendiente') ||
    lower.includes('borrador') ||
    lower.includes('draft') ||
    lower.includes('todo') ||
    lower.includes('indice') ||
    lower.includes('tabla de contenido');
}

function escapeYaml(str) {
  // Escape double quotes and ensure the string is safe for YAML
  return str.replace(/"/g, '\\"').replace(/\n/g, ' ');
}

// ─── Main parser ────────────────────────────────────────────────

function parseMarkdown(markdown) {
  const lines = markdown.split('\n');
  const notas = [];
  let currentNota = null;
  let pendingTag = null;
  let inSkippableSection = false;
  let tocEnded = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect and skip table of contents (usually at the beginning)
    // TOC typically has many links in sequence before any H1
    if (!tocEnded && !currentNota) {
      // If we hit the first H1, TOC is definitely over
      if (/^# /.test(trimmed)) {
        tocEnded = true;
      }
      // Skip lines that look like TOC entries (links, page numbers, etc.)
      else if (trimmed.match(/^\[.*\]/) || trimmed.match(/^\d+\.\s/) || trimmed === '') {
        continue;
      }
    }

    // Detect H1 — this starts a new nota
    if (/^# (.+)/.test(trimmed)) {
      // Strip any lingering HTML tags (e.g. <a id="..."></a> from Google Docs)
      const rawTitle = trimmed.replace(/^# /, '').trim();
      const title = rawTitle.replace(/<[^>]+>/g, '').replace(/\\\./g, '.').trim();

      // Check if this is a skippable section
      if (isSkippableSection(title)) {
        inSkippableSection = true;
        continue;
      }

      inSkippableSection = false;

      // Save previous nota if exists
      if (currentNota) {
        // Check if the last line(s) of the previous nota body might be a tag
        // for THIS nota (tag appears after body, before next title)
        const bodyLines = currentNota.bodyLines;
        for (let j = bodyLines.length - 1; j >= Math.max(0, bodyLines.length - 3); j--) {
          const candidateLine = bodyLines[j].trim();
          if (candidateLine === '') continue;
          if (isLikelyTag(candidateLine)) {
            // This is a trailing tag — belongs to the NEXT nota
            if (!pendingTag) {
              pendingTag = candidateLine;
            }
            bodyLines.splice(j, 1);
            break;
          }
          break; // Only check the last non-empty line
        }

        currentNota.body = bodyLines.join('\n').trim();
        notas.push(currentNota);
      }

      // Check if the line before this H1 was a tag (already in pendingTag,
      // or check the previous non-empty line)
      if (!pendingTag) {
        for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
          const prev = lines[j].trim();
          if (prev === '') continue;
          if (isLikelyTag(prev)) {
            pendingTag = prev;
          }
          break;
        }
      }

      currentNota = {
        title: title,
        tags: pendingTag ? [pendingTag] : [],
        bodyLines: [],
      };
      pendingTag = null;
      continue;
    }

    // If we're in a skippable section, ignore everything
    if (inSkippableSection) continue;

    // If no current nota yet, check if this line is a standalone tag
    if (!currentNota) {
      if (isLikelyTag(trimmed) && trimmed !== '') {
        pendingTag = trimmed;
      }
      continue;
    }

    // If we have a current nota, this is body content
    // But check if it's a standalone tag line between notes
    // (will be picked up when the next H1 is found)
    currentNota.bodyLines.push(line);
  }

  // Don't forget the last nota
  if (currentNota && !inSkippableSection) {
    // Check for trailing tag in last nota
    const bodyLines = currentNota.bodyLines;
    for (let j = bodyLines.length - 1; j >= Math.max(0, bodyLines.length - 3); j--) {
      const candidateLine = bodyLines[j].trim();
      if (candidateLine === '') continue;
      if (isLikelyTag(candidateLine)) {
        bodyLines.splice(j, 1);
      }
      break;
    }
    currentNota.body = bodyLines.join('\n').trim();
    notas.push(currentNota);
  }

  return notas;
}

// ─── DOCX to Markdown conversion ────────────────────────────────

async function convertDocxToMarkdown(filePath) {
  const buffer = await readFile(filePath);

  const result = await mammoth.convertToMarkdown(buffer, {
    styleMap: [
      "p[style-name='Heading 1'] => h1",
      "p[style-name='Heading 2'] => h2",
      "p[style-name='Heading 3'] => h3",
      "p[style-name='Heading 4'] => h4",
    ],
    // Skip images to avoid huge base64 blobs in the output
    convertImage: mammoth.images.imgElement(function() {
      return { src: '' };
    }),
  });

  // Strip HTML anchor tags (<a id="..."></a>) left by Google Docs internal links
  // and remove empty image tags generated above
  let markdown = result.value
    .replace(/<a\s+id="[^"]*"><\/a>/g, '')   // <a id="..."></a>
    .replace(/<a\s+id='[^']*'><\/a>/g, '')   // <a id='...'></a>
    .replace(/!\[\]\(\)/g, '')                // empty image references
    .replace(/!\[.*?\]\(data:image\/[^)]+\)/g, ''); // base64 images if any remain

  if (result.messages.length > 0) {
    const warnings = result.messages.filter(m => m.type === 'warning');
    if (warnings.length > 0) {
      console.log(`\n${warnings.length} avisos de conversion (ignorados)`);
    }
  }

  return markdown;
}

// ─── Generate .md files ─────────────────────────────────────────

function generateFrontmatter(nota) {
  const title = escapeYaml(nota.title);
  const tags = nota.tags.map(t => `"${escapeYaml(t)}"`).join(', ');
  const summary = escapeYaml(extractSummary(nota.body));
  const category = inferCategory(nota.title, nota.body);

  return `---
title: "${title}"
tags: [${tags}]
date: ${PLACEHOLDER_DATE}
category: "${category}"
image: ""
summary: "${summary}"
---`;
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Uso: node scripts/import-docx.js <ruta-al-archivo.docx>');
    console.error('Ejemplo: node scripts/import-docx.js ~/Downloads/notas.docx');
    process.exit(1);
  }

  const filePath = resolve(args[0]);
  console.log(`\nLeyendo archivo: ${filePath}`);

  // Convert .docx to markdown
  let markdown;
  try {
    markdown = await convertDocxToMarkdown(filePath);
  } catch (err) {
    console.error(`Error al leer el archivo .docx: ${err.message}`);
    process.exit(1);
  }

  console.log(`Conversion a Markdown completada (${markdown.length} caracteres)`);

  // Parse the markdown into individual notas
  const notas = parseMarkdown(markdown);

  if (notas.length === 0) {
    console.error('\nNo se encontraron notas en el documento.');
    console.error('Asegurate de que el documento use encabezados de nivel 1 (#) para los titulos.');
    process.exit(1);
  }

  console.log(`\nNotas encontradas: ${notas.length}\n`);

  // Ensure output directory exists
  await mkdir(OUTPUT_DIR, { recursive: true });

  // Generate .md files
  let created = 0;
  const slugsUsed = new Set();

  for (const nota of notas) {
    let slug = slugify(nota.title);

    // Handle duplicate slugs
    if (slugsUsed.has(slug)) {
      let counter = 2;
      while (slugsUsed.has(`${slug}-${counter}`)) counter++;
      slug = `${slug}-${counter}`;
    }
    slugsUsed.add(slug);

    const frontmatter = generateFrontmatter(nota);
    const fileContent = `${frontmatter}\n\n${nota.body}\n`;
    const outputPath = join(OUTPUT_DIR, `${slug}.md`);

    await writeFile(outputPath, fileContent, 'utf-8');

    const category = inferCategory(nota.title, nota.body);
    const tagStr = nota.tags.length > 0 ? ` [${nota.tags.join(', ')}]` : '';
    console.log(`  ${created + 1}. ${nota.title}${tagStr} (${category})`);

    created++;
  }

  console.log(`\n${created} notas importadas a ${OUTPUT_DIR}`);
  console.log('\nProximos pasos:');
  console.log('  1. Edita las fechas (date:) en cada archivo .md');
  console.log('  2. Revisa las categorias y tags asignados');
  console.log('  3. Agrega imagenes de portada si queres (image: "/images/nombre.jpg")');
  console.log('  4. Corre "npm run dev" para ver el sitio\n');
}

main().catch(err => {
  console.error('Error inesperado:', err);
  process.exit(1);
});
