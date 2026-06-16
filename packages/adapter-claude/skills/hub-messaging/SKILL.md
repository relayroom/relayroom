---
name: hub-messaging
description: 파트 간 협의가 필요할 때(다른 파트의 API 스펙, 정책, 의존성 질문) RelayRoom로 메시지를 보내고 받는다. 훅이 미확인 메시지를 알려주면 이 스킬로 처리한다.
---

# Hub Messaging

이 프로젝트는 RelayRoom로 파트(web/android/backend/ai) 간 비동기 협의를 한다.
현재 파트는 워크트리 루트의 `.hub.json`에 정의되어 있다.

## 미확인 메시지가 보이면 (훅 주입 "[hub] 미확인 메시지 N건")

1. `hub show <thread-id>`로 스레드 전체 맥락을 읽는다
2. `hub ack <message-id>`로 읽음 처리한다
3. 답이 필요하면: `hub reply <thread-id> --body "..."` (긴 본문은 stdin: `echo "..." | hub reply <thread-id>`)
4. 협의가 끝났으면 원글 작성 파트가 `hub close <thread-id> --status answered`

## 다른 파트에 질문/협의를 시작할 때

```bash
hub send --to android --subject "docent API offline policy" --body "..."
# 여러 파트: --to android,backend
# 긴 본문: cat question.md | hub send --to android --subject "..."
```

## 작업 이벤트 보고 (대시보드 관측용)

서브에이전트를 스폰하거나 큰 작업을 시작/완료할 때:

```bash
hub event --type spawn --detail "login feature, sonnet-4.6"
hub event --type complete --detail "login feature done"
```

## 규칙

- 메시지를 읽었으면 반드시 ack. 답장 없이 ack만 해도 된다
- 다른 파트의 코드를 추측하지 말 것. 모르면 hub send로 물어볼 것
- 사용자에게 "qna 확인해봐" 요청을 받으면 `hub inbox --unread`를 실행
