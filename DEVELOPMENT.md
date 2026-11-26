# Dashboard development in VS Code

Open `bantay-barangay-remote` in VS Code and use its integrated PowerShell terminal. The source requires Node.js 22.13 or later and the installed project dependencies.

## Prepare the local dashboard

If dependencies are missing, run `npm run install:ci`. Prepare the existing private demonstration accounts using these commands. The provision script preserves credentials that already exist.

```powershell
node scripts/provision-demo.mjs
$localSettings = Get-Content .sites-runtime/demo-secrets.json -Raw | ConvertFrom-Json
$localSettings.PSObject.Properties | ForEach-Object {
  $_.Name + "='" + $_.Value + "'"
} | Set-Content .dev.vars -Encoding utf8
```

The generated `.dev.vars` and `.sites-runtime` files are ignored by Git. The account handoff sheet is `.sites-runtime/accounts.txt`.

Apply the append-only schema migrations to the local preview database, then start the development server.

```powershell
node --import ./scripts/sites-env.mjs node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --local --config wrangler.local.jsonc --persist-to .wrangler/state
npm run dev
```

Open the URL printed in the terminal, usually `http://localhost:5173`. Use the same origin in the desktop app's **Remote dashboard** settings and the matching desktop token from the private local configuration. Sign in with the barangay name as both username and password (`641`, `638`, or `404`) — prototype credentials. Each account opens its assigned barangay.

The local migration configuration uses the same placeholder database ID as `vite.config.ts`. Local data persists under `.wrangler/state`. Hosted Cloudflare publication uses the separate workflow in `CLOUDFLARE.md`.

## ESP32 v2 readings

The desktop normalizes firmware `waterLevelCm` to the dashboard's filtered `station.level`. A v2 station also carries `schema`, `sourceKind`, `packetQuality`, `distanceCm`, `waterCalibrated`, `rainAvgIndex`, `rainPeakIndex`, and an optional `joystick` object with all four raw axes.

`bantay-bench-2` belongs to CEU's aggregate stream A in Barangay 641. Both joysticks contribute to that stream's rain proxy. The website presents the average and peak as unitless, uncalibrated indices from 0 to 100.

With firmware `SENSOR_TO_BOTTOM_CM = 0`, water level stays unavailable. Measure the sensor-to-bottom distance and set that constant in the ESP32 sketch. A usable raw ultrasonic reading can precede the three-sample water filter's first output. Air and rain proxy readings continue independently while water is unavailable or warming up.

Each channel preserves unavailable values as `null`. Legacy potentiometer packets retain their original interpretation. Desktop mode changes archive the previous mode's prompts, and valid recovery closes the current incident. Rain proxy values supply measurement context.

## Check source changes

```powershell
node --test lib/remote-api.test.mjs
npx tsc --noEmit --incremental false
```

These checks cover account isolation, incident recovery, mode changes, durable operator decisions, and v2 channel validation.
