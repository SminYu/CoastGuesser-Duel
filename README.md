# CoastGuesser WebRTC Referee Duel

CoastGuesser의 1P vs 2P 대전 MVP입니다. 게임 데이터와 점수 계산은 방장 브라우저가 담당하고, 플레이어 연결은 WebRTC DataChannel을 사용합니다.

## 구조

- Host: 방장, 심판, 관전자 역할입니다.
- 1P / 2P: 실제 추측을 제출하는 플레이어입니다.
- 연결 형태: Host를 중심으로 1P와 2P가 각각 직접 연결되는 star topology입니다.
- 게임 규칙: 10라운드, 라운드당 30초입니다.
- 점수 계산: Host 브라우저가 정답과 플레이어 추측 거리를 기준으로 계산합니다.
- 재시작: 한 번 연결된 WebRTC 채널을 유지한 채 새 10라운드 매치를 계속 시작할 수 있습니다.

## Firebase 방 코드

짧은 10자리 방 코드는 Firebase Cloud Firestore 문서 ID입니다. 실제 WebRTC Offer, Answer, ICE 후보는 Firestore에 잠깐 저장됩니다.

사용하려면 `firebase-config.js`의 placeholder 값을 Firebase 콘솔에서 받은 웹 앱 config로 교체하세요.

```js
window.COAST_DUEL_FIREBASE_CONFIG = {
  apiKey: "...",
  authDomain: "...firebaseapp.com",
  projectId: "...",
  storageBucket: "...firebasestorage.app",
  messagingSenderId: "...",
  appId: "..."
};
```

Firebase 설정이 비어 있으면 앱은 기존 수동 Offer/Answer 방식으로 자동 fallback합니다.

## Firestore 보안 규칙 예시

소규모 테스트용 최소 규칙입니다. 공개 페이지에서 익명으로 signaling을 쓰는 구조라 TTL/정리 정책을 함께 두는 것을 권장합니다.

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow read, create, update: if roomId.matches('^[0-9]{10}$');
      allow delete: if false;

      match /peers/{slot} {
        allow read, write: if roomId.matches('^[0-9]{10}$')
          && slot in ['p1', 'p2'];

        match /{candidateCollection}/{candidateId} {
          allow read, write: if roomId.matches('^[0-9]{10}$')
            && slot in ['p1', 'p2']
            && candidateCollection in ['playerCandidates', 'hostCandidates'];
        }
      }
    }
  }
}
```

## 로컬 실행

```powershell
cd webrtc-referee
python -m http.server 8000
```

브라우저에서 엽니다.

```text
http://localhost:8000
```

## 연결 순서

1. 방장이 `방장으로 열기`를 누릅니다.
2. 방장 화면에 나온 10자리 방 코드를 1P와 2P에게 전달합니다.
3. 플레이어는 슬롯을 고르고 방 코드를 입력해 연결합니다.
4. 1P와 2P가 Ready를 누르면 방장이 10라운드 매치를 시작합니다.

## 배포

정적 사이트이므로 GitHub Pages에 그대로 배포할 수 있습니다. 현재 workflow는 `.github/workflows/pages.yml`을 사용합니다.
