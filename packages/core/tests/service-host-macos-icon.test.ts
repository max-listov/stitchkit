import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APPLE_ICON_CANVAS_PX,
  APPLE_ICON_INSET_PX,
  APPLE_ICON_TILE_PX,
  APPLE_ICONSET_SLOTS,
  assertSafeSvg,
  assertValidIcnsBytes,
  generateAppIconIcns,
  ICONUTIL_PATH,
  type MacosCommandRunner,
  MacosIconError,
  QLMANAGE_PATH,
  renderAppleSquircleSvg,
  SIPS_PATH,
} from '../src/entrypoints/service-host/macos';

const VALID_PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const VALID_JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function createFakeIcnsBytes(): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set([0x69, 0x63, 0x6e, 0x73], 0); // 'icns'
  new DataView(bytes.buffer).setUint32(4, 16, false);
  return bytes;
}

describe('service-host/macos Apple squircle icon generation', () => {
  test('exposes Apple 1024/824/100 grid constants and all 10 .iconset slots', () => {
    expect(APPLE_ICON_CANVAS_PX).toBe(1024);
    expect(APPLE_ICON_TILE_PX).toBe(824);
    expect(APPLE_ICON_INSET_PX).toBe(100);
    expect(APPLE_ICONSET_SLOTS).toHaveLength(10);
    expect(APPLE_ICONSET_SLOTS.map((slot) => slot.filename)).toContain('icon_512x512@2x.png');
  });

  test('assertSafeSvg uses strict allowlist blocking XXE, entity-obfuscated hrefs, namespaced scripts, data:image/svg+xml, onload=, @import, and xml-stylesheet', () => {
    const maliciousSvgs = [
      '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg>&xxe;</svg>',
      '<svg><!ENTITY foo "bar"></svg>',
      '<?xml-stylesheet type="text/css" href="https://evil.example/a.css"?><svg/>',
      '<svg><script>alert(1)</script></svg>',
      '<svg xmlns:svg="http://www.w3.org/2000/svg"><svg:script>alert(1)</svg:script></svg>',
      '<svg><svg:foreignObject><body/></svg:foreignObject></svg>',
      '<svg onload="alert(1)"><circle cx="5" cy="5" r="4"/></svg>',
      '<svg><style>@import url("https://evil.example/x.css");</style></svg>',
      '<svg><image href="file:///etc/passwd" /></svg>',
      '<svg><image href="&#x66;ile:///etc/passwd" /></svg>',
      '<svg><image x:href="file:///etc/passwd" /></svg>',
      '<svg><image xlink:href="https://evil.example/a.png" /></svg>',
      '<svg><image href="//evil.example/a.png" /></svg>',
      '<svg><image href="/etc/passwd" /></svg>',
      '<svg><image href="data:image/svg+xml;base64,PHN2Zy8+" /></svg>',
      '<svg><rect style="fill:url(http://evil.example/x)" /></svg>',
      '<svg><rect style="fill:url(data:image/png;base64,AAAA)" /></svg>',
      '<html><body>not svg</body></html>',
    ];
    for (const svg of maliciousSvgs) {
      expect(() => assertSafeSvg(svg)).toThrow(MacosIconError);
    }
    expect(() =>
      assertSafeSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="clip1"><rect width="10" height="10"/></clipPath></defs><g clip-path="url(#clip1)"><use href="#clip1"/><image href="data:image/png;base64,iVBORw0KGgo="/></g></svg>',
      ),
    ).not.toThrow();
  });

  test('renderAppleSquircleSvg wraps SVG and JPEG in 824x824 clipPath, passes assertSafeSvg, and rejects unsafe colors', () => {
    const fromSvg = renderAppleSquircleSvg({
      innerSvg: '<svg viewBox="0 0 100 100"><rect width="100" height="100"/></svg>',
      backgroundColor: '#0f172a',
    });
    expect(fromSvg).toContain('width="1024" height="1024"');
    expect(fromSvg).toContain('x="100" y="100" width="824" height="824"');
    expect(fromSvg).toContain('fill="#0f172a"');
    expect(fromSvg).toContain('<svg x="100" y="100" width="824" height="824">');
    expect(() => assertSafeSvg(fromSvg)).not.toThrow();

    const fromJpeg = renderAppleSquircleSvg({
      embeddedImage: { mime: 'image/jpeg', bytes: VALID_JPEG_BYTES },
    });
    expect(fromJpeg).toContain('data:image/jpeg;base64,');
    expect(() => assertSafeSvg(fromJpeg)).not.toThrow();

    expect(() =>
      renderAppleSquircleSvg({
        innerSvg: '<svg/>',
        backgroundColor: '" onclick="evil()',
      }),
    ).toThrow(MacosIconError);
  });

  test('assertValidIcnsBytes accepts valid icns header and rejects corrupted magic or length', () => {
    expect(() => assertValidIcnsBytes(createFakeIcnsBytes())).not.toThrow();
    expect(() => assertValidIcnsBytes(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toThrow(
      MacosIconError,
    );
    const badLen = createFakeIcnsBytes();
    new DataView(badLen.buffer).setUint32(4, 9999, false);
    expect(() => assertValidIcnsBytes(badLen)).toThrow(MacosIconError);
  });

  test('generateAppIconIcns builds all 10 iconset sizes, verifies icns magic, writes output, and cleans staging even on failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stitchkit-macos-icon-test-'));
    try {
      const outputPath = join(dir, 'AppIcon.icns');
      const sipsCalls: Array<readonly string[]> = [];
      let iconutilCalled = false;
      let rasterizedSvg = '';

      const runner: MacosCommandRunner = {
        async runCommand(exe, args) {
          if (exe === SIPS_PATH) {
            sipsCalls.push(args);
            const outIdx = args.indexOf('--out');
            const outPath = args[outIdx + 1] ?? '';
            await writeFile(outPath, VALID_PNG_BYTES);
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (exe === ICONUTIL_PATH) {
            iconutilCalled = true;
            const outIdx = args.indexOf('-o');
            const outPath = args[outIdx + 1] ?? '';
            await writeFile(outPath, createFakeIcnsBytes());
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          return { exitCode: 1, stdout: '', stderr: 'unexpected' };
        },
      };

      const result = await generateAppIconIcns({
        source: {
          kind: 'svg',
          svg: '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="8"/></svg>',
          backgroundColor: '#111827',
        },
        outputPath,
        runner,
        async rasterizeSvg(svg, sizePx, outPngPath) {
          expect(sizePx).toBe(1024);
          rasterizedSvg = svg;
          await writeFile(outPngPath, VALID_PNG_BYTES);
        },
      });

      expect(rasterizedSvg).toContain('clipPath id="apple-squircle"');
      expect(sipsCalls).toHaveLength(10);
      expect(iconutilCalled).toBe(true);
      expect(result.byteLength).toBe(16);
      expect(Array.from(await readFile(outputPath))).toEqual(
        Array.from(createFakeIcnsBytes()),
      );
      expect(await readdir(dir)).toEqual(['AppIcon.icns']);

      // PNG without squircle frame skips rasterizeSvg
      let rasterCalled = false;
      const pngResult = await generateAppIconIcns({
        source: { kind: 'png', bytes: VALID_PNG_BYTES, applySquircleFrame: false },
        outputPath,
        runner,
        async rasterizeSvg() {
          rasterCalled = true;
        },
      });
      expect(rasterCalled).toBe(false);
      expect(pngResult.byteLength).toBe(16);

      // Default SVG rasterizer invokes qlmanage -t -s 1024 followed by sips normalization
      const qlCalls: Array<{ exe: string; args: readonly string[] }> = [];
      const qlRunner: MacosCommandRunner = {
        async runCommand(exe, args) {
          qlCalls.push({ exe, args });
          if (exe === QLMANAGE_PATH) {
            const outDir = args[args.indexOf('-o') + 1] ?? '';
            await writeFile(join(outDir, 'icon.svg.png'), VALID_PNG_BYTES);
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (exe === SIPS_PATH) {
            const outPath = args[args.indexOf('--out') + 1] ?? '';
            await writeFile(outPath, VALID_PNG_BYTES);
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          const outPath = args[args.indexOf('-o') + 1] ?? '';
          await writeFile(outPath, createFakeIcnsBytes());
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      };
      await generateAppIconIcns({
        source: {
          kind: 'svg',
          svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
        },
        outputPath,
        runner: qlRunner,
      });
      expect(qlCalls[0]?.exe).toBe(QLMANAGE_PATH);
      expect(qlCalls[0]?.args.slice(0, 3)).toEqual(['-t', '-s', '1024']);
      expect(qlCalls[1]?.exe).toBe(SIPS_PATH);
      expect(qlCalls[1]?.args.slice(0, 3)).toEqual(['-s', 'format', 'png']);

      // Corrupted icns output fails with INVALID_ICNS and still cleans up staging dir
      const badIconutilRunner: MacosCommandRunner = {
        async runCommand(exe, args) {
          if (exe === SIPS_PATH) {
            const outPath = args[args.indexOf('--out') + 1] ?? '';
            await writeFile(outPath, VALID_PNG_BYTES);
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          const outPath = args[args.indexOf('-o') + 1] ?? '';
          await writeFile(outPath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      };
      await expect(
        generateAppIconIcns({
          source: { kind: 'jpeg', bytes: VALID_JPEG_BYTES },
          outputPath,
          runner: badIconutilRunner,
          async rasterizeSvg(_svg, _px, outPngPath) {
            await writeFile(outPngPath, VALID_PNG_BYTES);
          },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ICNS' });
      expect(await readdir(dir)).toEqual(['AppIcon.icns']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
