# F1 게임 — Vercel 배포

## 업로드

이 폴더 **안의 모든 파일과 하위 폴더**를 GitHub 저장소에 올립니다. `api`, `lib`, `public` 폴더 구조를 그대로 유지하세요. Dockerfile은 필요 없습니다.

Vercel → Add New → Project → GitHub 저장소 선택 → Import.

- Framework Preset: **Other**
- Root Directory: `package.json`과 `vercel.json`이 있는 위치
- 폴더 자체를 GitHub에 올렸다면 Root Directory를 `F1-VERCEL-20260930`으로 지정
- Build Command: `node verify.cjs`
- Output Directory: `public`

## 로그인·기록·온라인 방용 저장소 연결 (필수)

Vercel 프로젝트의 Storage/Marketplace에서 **Upstash Redis**를 생성하고 이 프로젝트에 연결합니다.
공식 안내: https://upstash.com/docs/redis/howto/vercelintegration

다음 환경변수가 연결되어야 합니다:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

`KV_REST_API_URL`, `KV_REST_API_TOKEN` 이름으로 연결되는 경우도 지원합니다.
프로젝트 Settings → Environment Variables에서 `AUTH_PEPPER`도 추가하세요. 값은 본인만 아는 무작위 문자열 32자 이상입니다. PowerShell에서 다음 명령으로 64자 값을 생성할 수 있습니다:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

생성한 값은 Vercel 환경변수에만 넣고 GitHub에 올리지 마세요. 값을 나중에 바꾸면 기존 계정 PIN 검증이 실패하므로 그대로 보관하세요.
설정을 저장한 뒤 **Redeploy** 하세요. `APP_ORIGIN`, `DATA_DIR`, `PORT` 설정은 필요 없습니다.

## 확인

배포 주소에서 `/api/health`를 열어 `status: ok`, `storage: connected`가 나오는지 확인합니다.
이후 가입 → 로그인 → 타임어택 → 다른 브라우저에서 방 참여 순서로 확인하세요.
같은 배포 주소를 친구에게 보내면 됩니다. Production/Preview 데이터는 서로 분리됩니다.

## 참고

- 게임 화면·조작 코드는 기존 파일 그대로이며, 서버만 Vercel 함수와 공유 Redis 저장소에 맞췄습니다.
- 기존 로컬/Render SQLite 계정과 기록은 자동 이전되지 않습니다. 이 배포에서는 새로 가입해야 합니다.
- 온라인 대전은 기존 주기적 HTTP 동기화 방식입니다. 지연·사용량은 Vercel/Redis 지역과 요금제에 영향을 받습니다. 친구 소규모 이용용이며 대규모 서비스용 설계는 아닙니다.
- Redis는 서버 전용입니다. 브라우저에 연결 토큰이나 PIN 원문을 노출하지 않습니다.
- 저장소 연결 전에도 빌드는 가능하지만 가입·로그인·온라인 방은 사용할 수 없습니다.
- 로컬 검사: `node verify.cjs`. 실제 Vercel 및 Redis 연결 검증은 계정을 연결한 뒤 필요합니다.
