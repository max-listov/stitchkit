import { codeToHtml } from 'shiki';

const example = `const snapshot = await api.repository.read();

await api.repository.refresh();
// The same operations are available to HTTP, MCP, agents and CLI.`;

export async function CodeFoundationSection() {
  const html = await codeToHtml(example, {
    lang: 'ts',
    themes: {
      light: 'github-light-high-contrast',
      dark: 'github-dark-high-contrast',
    },
    defaultColor: false,
  });

  return (
    <section className='grid gap-8 py-14 md:grid-cols-[0.8fr_1.2fr] md:items-center'>
      <div>
        <p className='text-sm text-muted-foreground'>Inspect the foundation</p>
        <h2 className='mt-2 text-3xl font-medium'>The useful path stays short</h2>
        <p className='mt-3 text-muted-foreground'>
          Application code calls a typed client while validation, transport and observability
          remain framework-owned.
        </p>
      </div>
      <div
        className='overflow-auto rounded-2xl border border-border bg-card p-5 text-sm [&_pre]:bg-transparent!'
        // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki renders a static authored code sample.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </section>
  );
}
