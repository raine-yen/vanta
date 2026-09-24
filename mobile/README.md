# Paper Trader Expo App

This Expo app shares data with the website through the same Express API routes backed by MySQL. See [HOSTINGER_ENDPOINT_NOTES.md](HOSTINGER_ENDPOINT_NOTES.md) for the deferred production endpoint switch.

## Test with Expo Go

1. Start the web backend from the repo root:

```bash
npm run dev
```

2. Set the mobile API URL:

```bash
cd mobile
copy .env.example .env
```

Use your computer LAN IP for a physical phone, for example:

```text
EXPO_PUBLIC_API_URL=http://192.168.1.25:3000
```

3. Start Expo:

```bash
npm start
```

4. Scan the QR code with Expo Go.

The Expo app and website now share users, accounts, positions, orders, API keys, quotes, and leaderboard data.

## Publish path

1. Deploy the website/API to Hostinger.
2. Set `EXPO_PUBLIC_API_URL` to the Hostinger HTTPS URL.
3. Run `npx eas-cli@latest init`.
4. Replace `extra.eas.projectId` in `app.json` with the generated EAS project id.
5. Build TestFlight:

```bash
npx eas-cli@latest build -p ios --profile production
```

6. Submit:

```bash
npx eas-cli@latest submit -p ios --profile production
```
