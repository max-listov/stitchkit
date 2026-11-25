import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../../internal/atomic-file';
import { computeSha256Hex } from '../artifact-manifest';
import {
  createDefaultMacosCommandRunner,
  ICONUTIL_PATH,
  type MacosCommandRunner,
  QLMANAGE_PATH,
  SIPS_PATH,
} from './runner';

/** Apple macOS Big Sur+ master icon canvas width/height in pixels. */
export const APPLE_ICON_CANVAS_PX = 1024;

/** Apple macOS Big Sur+ squircle tile width/height inside the 1024×1024 canvas. */
export const APPLE_ICON_TILE_PX = 824;

/** Apple macOS Big Sur+ outer inset on each side (`(1024 - 824) / 2`). */
export const APPLE_ICON_INSET_PX = 100;

/** Approximate Apple continuous squircle corner radius for an 824×824 tile. */
export const APPLE_ICON_CORNER_RADIUS_PX = 185;

/** One required `.iconset` slot consumed by macOS `iconutil`. */
export interface AppleIconsetSlot {
  readonly filename: string;
  readonly pixels: number;
}

/** Standard 10-slot macOS `.iconset` matrix required by `iconutil -c icns`. */
export const APPLE_ICONSET_SLOTS: readonly AppleIconsetSlot[] = [
  { filename: 'icon_16x16.png', pixels: 16 },
  { filename: 'icon_16x16@2x.png', pixels: 32 },
  { filename: 'icon_32x32.png', pixels: 32 },
  { filename: 'icon_32x32@2x.png', pixels: 64 },
  { filename: 'icon_128x128.png', pixels: 128 },
  { filename: 'icon_128x128@2x.png', pixels: 256 },
  { filename: 'icon_256x256.png', pixels: 256 },
  { filename: 'icon_256x256@2x.png', pixels: 512 },
  { filename: 'icon_512x512.png', pixels: 512 },
  { filename: 'icon_512x512@2x.png', pixels: 1024 },
];

const SAFE_COLOR_PATTERN = /^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,24}|rgba?\([0-9.,\s%]+\))$/;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Failure classifications thrown by {@link MacosIconError}. */
export type MacosIconErrorCode =
  | 'INVALID_SOURCE'
  | 'UNSAFE_SVG'
  | 'COMMAND_FAILED'
  | 'INVALID_ICNS';

/** Structured error thrown by macOS `AppIcon.icns` validation and generation helpers. */
export class MacosIconError extends Error {
  readonly code: MacosIconErrorCode;
  constructor(code: MacosIconErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MacosIconError';
    this.code = code;
  }
}

/** Zod schema for icon artwork accepted by {@link generateAppIconIcns}. */
export const MacosIconSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('svg'),
    svg: z.string().min(1),
    applySquircleFrame: z.boolean().default(true),
    backgroundColor: z.string().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal('jpeg'),
    bytes: z.instanceof(Uint8Array),
    backgroundColor: z.string().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal('png'),
    bytes: z.instanceof(Uint8Array),
    applySquircleFrame: z.boolean().default(false),
    backgroundColor: z.string().min(1).optional(),
  }),
]);

/** Input artwork accepted by {@link generateAppIconIcns}. */
export type MacosIconSource = z.input<typeof MacosIconSourceSchema>;

/** Options for {@link renderAppleSquircleSvg}. */
export interface RenderAppleSquircleSvgOptions {
  /** Safe inner SVG markup placed inside the 824×824 Apple squircle clip path. */
  innerSvg?: string;
  /** Embedded raster image placed inside the 824×824 Apple squircle clip path. */
  embeddedImage?: {
    mime: 'image/jpeg' | 'image/png';
    bytes: Uint8Array;
  };
  /** Optional safe background fill colour (e.g. `#111827`). */
  backgroundColor?: string;
}

/** Options for {@link generateAppIconIcns}. */
export interface GenerateAppIconIcnsOptions {
  source: MacosIconSource;
  outputPath: string;
  /**
   * Injectable SVG rasterizer producing a `sizePx × sizePx` PNG at `outPngPath`.
   * Defaults to `/usr/bin/qlmanage` + `/usr/bin/sips`.
   */
  rasterizeSvg?: (svg: string, sizePx: number, outPngPath: string) => Promise<void>;
  timeoutMs?: number;
  runner?: MacosCommandRunner;
}

/** Result returned by {@link generateAppIconIcns}. */
export interface GenerateAppIconIcnsResult {
  outputPath: string;
  sha256: string;
  byteLength: number;
}

const FORBIDDEN_SVG_CONSTRUCTS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'DOCTYPE declaration', pattern: /<!DOCTYPE\b/i },
  { label: 'ENTITY declaration', pattern: /<!ENTITY\b/i },
  { label: 'xml-stylesheet processing instruction', pattern: /<\?xml-stylesheet\b/i },
  {
    label: 'script or foreignObject element',
    pattern: /<(?:[\w-]+:)?(?:script|foreignObject)\b/i,
  },
  { label: 'CSS @import directive', pattern: /@import\b/i },
  { label: 'inline event handler attribute', pattern: /\bon[a-z]+\s*=/i },
];
const HREF_ATTR_PATTERN =
  /(?:^|[\s<])(?:[\w-]+:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const CSS_URL_PATTERN = /\burl\s*\(\s*([^)]*)\)/gi;
const ALLOWED_FRAGMENT_REF = /^#[A-Za-z_][\w.-]*$/;
const ALLOWED_DATA_IMAGE_URI = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=\s]+$/i;

/**
 * Strictly validate an SVG document using an allowlist for `href` and `url(...)`
 * references (only `#id` fragments and base64 `data:image/png|jpeg` URIs are
 * permitted) while blocking `<!DOCTYPE`, `<!ENTITY`, `<?xml-stylesheet`,
 * namespaced `<script>`/`<foreignObject>`, `@import`, and inline `on*=` handlers.
 */
export function assertSafeSvg(svg: string): void {
  if (!/<svg\b/i.test(svg)) {
    throw new MacosIconError('UNSAFE_SVG', 'SVG source must contain an <svg> root element');
  }
  for (const check of FORBIDDEN_SVG_CONSTRUCTS) {
    if (check.pattern.test(svg)) {
      throw new MacosIconError('UNSAFE_SVG', `SVG source rejected: forbidden ${check.label}`);
    }
  }
  for (const match of svg.matchAll(HREF_ATTR_PATTERN)) {
    const rawValue = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!ALLOWED_FRAGMENT_REF.test(rawValue) && !ALLOWED_DATA_IMAGE_URI.test(rawValue)) {
      throw new MacosIconError(
        'UNSAFE_SVG',
        `SVG source rejected: disallowed href value (${JSON.stringify(rawValue.slice(0, 48))})`,
      );
    }
  }
  for (const match of svg.matchAll(CSS_URL_PATTERN)) {
    const cleaned = (match[1] ?? '')
      .trim()
      .replace(/^["']|["']$/g, '')
      .trim();
    if (!ALLOWED_FRAGMENT_REF.test(cleaned)) {
      throw new MacosIconError(
        'UNSAFE_SVG',
        `SVG source rejected: disallowed url() reference (${JSON.stringify(cleaned.slice(0, 48))})`,
      );
    }
  }
}

function assertSafeColor(color: string): void {
  if (!SAFE_COLOR_PATTERN.test(color.trim())) {
    throw new MacosIconError(
      'INVALID_SOURCE',
      `Invalid icon backgroundColor: ${JSON.stringify(color)}`,
    );
  }
}

function assertPngMagic(bytes: Uint8Array): void {
  if (bytes.byteLength < PNG_MAGIC.length) {
    throw new MacosIconError('INVALID_SOURCE', 'PNG source is truncated');
  }
  for (let index = 0; index < PNG_MAGIC.length; index += 1) {
    if (bytes[index] !== PNG_MAGIC[index]) {
      throw new MacosIconError(
        'INVALID_SOURCE',
        'PNG source does not start with PNG signature',
      );
    }
  }
}

function assertJpegMagic(bytes: Uint8Array): void {
  if (bytes.byteLength < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new MacosIconError('INVALID_SOURCE', 'JPEG source does not start with SOI marker');
  }
}

/** Verify that `bytes` starts with the 4-byte `icns` magic and valid length header. */
export function assertValidIcnsBytes(bytes: Uint8Array): void {
  if (
    bytes.byteLength < 8 ||
    bytes[0] !== 0x69 ||
    bytes[1] !== 0x63 ||
    bytes[2] !== 0x6e ||
    bytes[3] !== 0x73
  ) {
    throw new MacosIconError(
      'INVALID_ICNS',
      'Generated icon file is missing the "icns" magic',
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredLength = view.getUint32(4, false);
  if (declaredLength < 8 || declaredLength > bytes.byteLength) {
    throw new MacosIconError(
      'INVALID_ICNS',
      `Generated icns header length (${declaredLength}) is invalid for ${bytes.byteLength} bytes`,
    );
  }
}

/**
 * Wrap safe SVG markup or an embedded JPEG/PNG image inside the standard Apple
 * 1024×1024 canvas with an 824×824 squircle tile inset by 100px on every side.
 */
export function renderAppleSquircleSvg(options: RenderAppleSquircleSvgOptions): string {
  const hasSvg = options.innerSvg !== undefined;
  const hasImage = options.embeddedImage !== undefined;
  if (hasSvg === hasImage) {
    throw new MacosIconError(
      'INVALID_SOURCE',
      'renderAppleSquircleSvg requires exactly one of innerSvg or embeddedImage',
    );
  }
  if (options.backgroundColor !== undefined) {
    assertSafeColor(options.backgroundColor);
  }

  const inset = APPLE_ICON_INSET_PX;
  const tile = APPLE_ICON_TILE_PX;
  const radius = APPLE_ICON_CORNER_RADIUS_PX;
  const canvas = APPLE_ICON_CANVAS_PX;

  let body: string;
  if (options.innerSvg !== undefined) {
    assertSafeSvg(options.innerSvg);
    const stripped = options.innerSvg.replace(/<\?xml[\s\S]*?\?>/gi, '').trim();
    body = `    <svg x="${inset}" y="${inset}" width="${tile}" height="${tile}">\n${stripped}\n    </svg>`;
  } else {
    const image = options.embeddedImage;
    if (!image) {
      throw new MacosIconError('INVALID_SOURCE', 'Missing embedded image');
    }
    if (image.mime === 'image/jpeg') assertJpegMagic(image.bytes);
    else assertPngMagic(image.bytes);
    const encoded = Buffer.from(image.bytes).toString('base64');
    body = `    <image href="data:${image.mime};base64,${encoded}" x="${inset}" y="${inset}" width="${tile}" height="${tile}" preserveAspectRatio="xMidYMid slice" />`;
  }

  const backgroundRect =
    options.backgroundColor !== undefined
      ? `    <rect x="${inset}" y="${inset}" width="${tile}" height="${tile}" fill="${options.backgroundColor.trim()}" />\n`
      : '';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}">`,
    '  <defs>',
    '    <clipPath id="apple-squircle">',
    `      <rect x="${inset}" y="${inset}" width="${tile}" height="${tile}" rx="${radius}" ry="${radius}" />`,
    '    </clipPath>',
    '  </defs>',
    '  <g clip-path="url(#apple-squircle)">',
    `${backgroundRect}${body}`,
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
}

/**
 * Generate a verified macOS `AppIcon.icns` from SVG, JPEG, or PNG artwork using
 * the Apple 1024/824/100 squircle grid, a staged 10-slot `.iconset`, `sips`,
 * and `iconutil`, always removing the staging directory in `finally`.
 */
export async function generateAppIconIcns(
  options: GenerateAppIconIcnsOptions,
): Promise<GenerateAppIconIcnsResult> {
  if (!options.outputPath.startsWith('/') || options.outputPath.includes('\0')) {
    throw new MacosIconError(
      'INVALID_SOURCE',
      `Invalid icns outputPath: ${JSON.stringify(options.outputPath)}`,
    );
  }
  const parsedResult = MacosIconSourceSchema.safeParse(options.source);
  if (!parsedResult.success) {
    throw new MacosIconError(
      'INVALID_SOURCE',
      `Invalid macOS icon source: ${parsedResult.error.message}`,
      { cause: parsedResult.error },
    );
  }
  const source = parsedResult.data;
  const runner = options.runner ?? createDefaultMacosCommandRunner();
  const cmdOpts =
    options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : undefined;

  const parentDir = dirname(options.outputPath);
  await mkdir(parentDir, { recursive: true });
  const stagingDir = await mkdtemp(join(parentDir, '.icon-stage-'));
  const masterPngPath = join(stagingDir, 'master.png');
  const iconsetDir = join(stagingDir, 'AppIcon.iconset');
  const stagedIcnsPath = join(stagingDir, 'AppIcon.icns');

  const defaultRasterizeSvg = async (
    svgDoc: string,
    sizePx: number,
    outPngPath: string,
  ): Promise<void> => {
    const svgPath = join(stagingDir, 'icon.svg');
    const qlOutPath = join(stagingDir, 'icon.svg.png');
    await writeFile(svgPath, svgDoc, 'utf8');
    const qlResult = await runner.runCommand(
      QLMANAGE_PATH,
      ['-t', '-s', String(sizePx), '-o', stagingDir, svgPath],
      cmdOpts,
    );
    if (qlResult.exitCode !== 0) {
      throw new MacosIconError(
        'COMMAND_FAILED',
        `qlmanage failed to rasterize SVG (exit ${qlResult.exitCode}): ${qlResult.stderr.trim()}`,
      );
    }
    const sipsResult = await runner.runCommand(
      SIPS_PATH,
      [
        '-s',
        'format',
        'png',
        '-z',
        String(sizePx),
        String(sizePx),
        qlOutPath,
        '--out',
        outPngPath,
      ],
      cmdOpts,
    );
    if (sipsResult.exitCode !== 0) {
      throw new MacosIconError(
        'COMMAND_FAILED',
        `sips failed to normalize rasterized SVG (exit ${sipsResult.exitCode}): ${sipsResult.stderr.trim()}`,
      );
    }
  };
  const rasterizeSvg = options.rasterizeSvg ?? defaultRasterizeSvg;

  try {
    if (source.kind === 'svg') {
      assertSafeSvg(source.svg);
      const svgDoc = source.applySquircleFrame
        ? renderAppleSquircleSvg({
            innerSvg: source.svg,
            backgroundColor: source.backgroundColor,
          })
        : source.svg;
      await rasterizeSvg(svgDoc, APPLE_ICON_CANVAS_PX, masterPngPath);
    } else if (source.kind === 'jpeg') {
      assertJpegMagic(source.bytes);
      const svgDoc = renderAppleSquircleSvg({
        embeddedImage: { mime: 'image/jpeg', bytes: source.bytes },
        backgroundColor: source.backgroundColor,
      });
      await rasterizeSvg(svgDoc, APPLE_ICON_CANVAS_PX, masterPngPath);
    } else {
      assertPngMagic(source.bytes);
      if (source.applySquircleFrame) {
        const svgDoc = renderAppleSquircleSvg({
          embeddedImage: { mime: 'image/png', bytes: source.bytes },
          backgroundColor: source.backgroundColor,
        });
        await rasterizeSvg(svgDoc, APPLE_ICON_CANVAS_PX, masterPngPath);
      } else {
        await writeFile(masterPngPath, source.bytes);
      }
    }

    await mkdir(iconsetDir, { recursive: true });
    for (const slot of APPLE_ICONSET_SLOTS) {
      const slotPath = join(iconsetDir, slot.filename);
      const sipsResult = await runner.runCommand(
        SIPS_PATH,
        ['-z', String(slot.pixels), String(slot.pixels), masterPngPath, '--out', slotPath],
        cmdOpts,
      );
      if (sipsResult.exitCode !== 0) {
        throw new MacosIconError(
          'COMMAND_FAILED',
          `sips failed for ${slot.filename} (exit ${sipsResult.exitCode}): ${sipsResult.stderr.trim()}`,
        );
      }
    }

    const iconutilResult = await runner.runCommand(
      ICONUTIL_PATH,
      ['-c', 'icns', iconsetDir, '-o', stagedIcnsPath],
      cmdOpts,
    );
    if (iconutilResult.exitCode !== 0) {
      throw new MacosIconError(
        'COMMAND_FAILED',
        `iconutil failed (exit ${iconutilResult.exitCode}): ${iconutilResult.stderr.trim()}`,
      );
    }

    const icnsBytes = new Uint8Array(await readFile(stagedIcnsPath));
    assertValidIcnsBytes(icnsBytes);
    await writeFileAtomic(options.outputPath, icnsBytes, { mode: 0o644 });
    return {
      outputPath: options.outputPath,
      sha256: computeSha256Hex(icnsBytes),
      byteLength: icnsBytes.byteLength,
    };
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
