# Trusted LAN HTTPS development

Use this optional mode to test microphone, camera, PWA and WebRTC behavior on a
physical device connected to the same private network:

```bash
# Install the maintained local-CA tool first:
brew install mkcert

bun run dev:lan
# Multiple private interfaces:
bun run dev:lan --host 192.168.1.20
```

The launcher uses mkcert, stores leaf certificates under
`~/.local/share/<app-slug>/lan-https`, and keeps the CA in mkcert's own CAROOT.
No certificate or machine address is written into the project. When the chosen
address changes, only the leaf certificate is renewed.

The command prints the HTTPS web/API URLs and a development-only onboarding URL.
Open that URL on the phone to download the **public** root certificate. On iOS,
install the profile and enable full trust under Certificate Trust Settings. On
Android, install it as a CA certificate; native development builds must opt into
user-installed roots. The private CA key is never served.

`bun run dev` remains plain localhost HTTP. Production never reads the LAN
certificate variables or mounts the onboarding routes.

