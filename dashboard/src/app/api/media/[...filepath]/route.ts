import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';
import { getCTXRoot, getFrameworkRoot, getAllowedRootsConfigPath } from '@/lib/config';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Allowed roots — controls which directories the media API can serve from.
//
// CTX_ROOT is always implicitly allowed. Additional directories can be added
// via Settings > Allowed Roots so agents can reference files from project
// trees outside the default runtime directory. The list is stored in
// {CTX_ROOT}/config/allowed-roots.json and read on every request.
// ---------------------------------------------------------------------------

interface AllowedRootsFile {
  additional_roots?: string[];
}

function readAllowedRoots(): string[] {
  const configPath = getAllowedRootsConfigPath();
  if (!fs.existsSync(configPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as AllowedRootsFile;
    if (!Array.isArray(parsed.additional_roots)) return [];
    return parsed.additional_roots.filter((r): r is string => typeof r === 'string');
  } catch {
    return [];
  }
}

function isPathUnderAnyRoot(realPath: string, roots: string[]): boolean {
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(path.resolve(root));
    } catch {
      continue;
    }
    if (realPath === realRoot) return true;
    const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (realPath.startsWith(rootWithSep)) return true;
  }
  return false;
}

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/plain; charset=utf-8',
  // SECURITY: .html/.htm are deliberately served as text/plain, NOT text/html.
  // Agent-written HTML served inline as text/html would execute scripts on the
  // dashboard origin (stored XSS → auth-cookie theft). The dashboard's own
  // HTML preview (deliverable-preview.tsx) fetches the body as text and renders
  // it in a sandboxed srcDoc iframe, so it does not rely on this content type.
  '.html': 'text/plain; charset=utf-8',
  '.htm': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.js': 'text/plain; charset=utf-8',
  '.css': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);
const INLINE_EXTENSIONS = new Set(['.md', '.html', '.htm', '.txt', '.ts', '.tsx', '.js', '.css', '.sh', '.json', '.csv']);

// ---------------------------------------------------------------------------
// Sensitive-file denylist.
//
// SECURITY: agent directories under the allowed roots contain credential
// files (.env with BOT_TOKEN/CHAT_ID, key material, secrets files). Without
// this check, GET /api/media/orgs/<org>/agents/<name>/.env would serve the
// agent's credentials to any authenticated dashboard user.
//
// The check is applied to the basename of the RESOLVED real path (after
// fs.realpathSync), so `..` traversal, URL-encoding tricks, and symlinks
// pointing at a blocked file cannot smuggle a blocked name past the filter.
// Only the final segment is checked: files that merely live inside a dot
// directory (e.g. .claude/skills/foo/SKILL.md) remain servable.
// ---------------------------------------------------------------------------
const BLOCKED_KEY_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx']);

function isSensitiveBasename(basename: string): boolean {
  const lower = basename.toLowerCase();
  // All dotfiles: .env, .env.local, .env.production, .npmrc, .netrc, ...
  if (lower.startsWith('.')) return true;
  // secrets, secrets.json, secrets-prod.yaml, ...
  if (lower.startsWith('secrets')) return true;
  // Private key / cert-bundle material by extension.
  if (BLOCKED_KEY_EXTENSIONS.has(path.extname(lower))) return true;
  return false;
}

/**
 * GET /api/media/[...filepath]
 * Serve a local file by its path relative to CTX_ROOT (or an absolute path
 * if it falls within an allowed root). Supports ?render=true for markdown
 * files to return rendered HTML instead of raw text.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ filepath: string[] }> }
) {
  const { filepath } = await params;
  const ctxRoot = getCTXRoot();

  // Reconstruct the relative path from the URL segments.
  const relativePath = filepath.join('/');
  const frameworkRoot = getFrameworkRoot();
  const additionalRoots = readAllowedRoots();
  const validRoots = [ctxRoot, frameworkRoot, ...additionalRoots];

  // Resolve the file against configured roots in two passes.
  //
  // Pass 1 — direct resolve: path.resolve(root, relativePath).
  // Works when the file sits directly under the root.
  //
  // Pass 2 — overlap-stripped resolve: when a root's tail matches the
  // relative path's head, strip the overlap to avoid doubling path
  // components. Example: root "C:/x/orgs/foo" + rel "orgs/foo/bar.md"
  // → pass 1 tries "C:/x/orgs/foo/orgs/foo/bar.md" (wrong),
  // → pass 2 strips "orgs/foo" overlap → "C:/x/orgs/foo/bar.md" (correct).
  //
  // Both passes enforce the same security check: the resolved real path
  // must fall within a configured allowed root.
  let realFullPath: string | null = null;

  function tryResolve(candidate: string): boolean {
    try {
      const real = fs.realpathSync(candidate);
      if (isPathUnderAnyRoot(real, validRoots)) {
        realFullPath = real;
        return true;
      }
    } catch {
      // File doesn't exist at this path
    }
    return false;
  }

  // Pass 1: direct resolve
  for (const root of validRoots) {
    if (tryResolve(path.resolve(root, relativePath))) break;
  }

  // Pass 2: overlap-stripped resolve
  if (!realFullPath) {
    const relParts = relativePath.split('/');
    for (const root of validRoots) {
      const rootParts = root.replace(/\\/g, '/').split('/');
      const maxOverlap = Math.min(rootParts.length, relParts.length);
      for (let n = maxOverlap; n > 0; n--) {
        const rootTail = rootParts.slice(-n).join('/').toLowerCase();
        const relHead = relParts.slice(0, n).join('/').toLowerCase();
        if (rootTail === relHead) {
          const stripped = relParts.slice(n).join('/');
          if (!stripped) continue;
          if (tryResolve(path.resolve(root, stripped))) break;
        }
      }
      if (realFullPath) break;
    }
  }

  if (!realFullPath) {
    // Suggest which directory to add based on the first root candidate tried
    const suggestedDir = path.dirname(path.resolve(ctxRoot, relativePath)).replace(/\\/g, '/');
    return new Response(
      JSON.stringify({
        error: 'not_found',
        message: `File not found under any configured root. To fix: go to Settings > Allowed Roots and add the directory that contains this file (e.g. "${suggestedDir}"), or re-attach as a snapshot via save-output.`,
        configured_roots: validRoots,
      }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // SECURITY: refuse to serve secrets/dotfiles/key material even when they
  // resolve under a valid root. Checked on the resolved basename (post-
  // realpath, post-symlink) so it cannot be bypassed via `..` or encoding.
  // Responds with the same 404 shape as a resolution miss so the route does
  // not act as a file-existence oracle for blocked names.
  if (isSensitiveBasename(path.basename(realFullPath))) {
    return new Response(
      JSON.stringify({
        error: 'not_found',
        message: 'File not found under any configured root.',
      }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const ext = path.extname(realFullPath).toLowerCase();
  const renderMd = _request.nextUrl.searchParams.get('render') === 'true';

  // Markdown render mode: convert to HTML fragment for the preview panel.
  // Agent-generated markdown can contain raw inline HTML (e.g. <script>,
  // onerror handlers, javascript: URIs). We sanitize the marked output with
  // DOMPurify before returning it so the client can safely inject it via
  // dangerouslySetInnerHTML. FORBID_TAGS covers the dangerous vectors that
  // the default DOMPurify config doesn't already strip on some configs.
  if (renderMd && ext === '.md') {
    const mdContent = fs.readFileSync(realFullPath, 'utf-8');
    const rawHtml = marked.parse(mdContent) as string;
    const htmlBody = DOMPurify.sanitize(rawHtml, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'link', 'meta', 'base'],
      FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onchange', 'onsubmit', 'formaction'],
    });
    return new Response(htmlBody, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(htmlBody)),
        'Cache-Control': 'private, max-age=60',
      },
    });
  }

  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
  const fileBuffer = fs.readFileSync(realFullPath);

  const headers: Record<string, string> = {
    'Content-Type': mimeType,
    'Content-Length': String(fileBuffer.length),
    'Cache-Control': 'private, max-age=3600',
    // SECURITY: prevent browsers from MIME-sniffing text/plain responses
    // (e.g. .html served as text/plain above) back into executable HTML.
    'X-Content-Type-Options': 'nosniff',
  };

  // SECURITY: defense-in-depth for document types that can execute script on
  // the dashboard origin when navigated to directly. CSP `sandbox` puts the
  // response in an opaque origin with scripts disabled. SVG renders fine as
  // <img> (where scripts never run) and inline markup still displays; this
  // only constrains direct navigation.
  if (ext === '.html' || ext === '.htm' || ext === '.svg') {
    headers['Content-Security-Policy'] = 'sandbox';
  }

  if (IMAGE_EXTENSIONS.has(ext) || INLINE_EXTENSIONS.has(ext)) {
    headers['Content-Disposition'] = `inline; filename="${path.basename(realFullPath)}"`;
  } else {
    headers['Content-Disposition'] = `attachment; filename="${path.basename(realFullPath)}"`;
  }

  return new Response(fileBuffer, { status: 200, headers });
}
