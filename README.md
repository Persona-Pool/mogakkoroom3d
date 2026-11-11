This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
# mogakkoroom3d
# mogakkoroom3d
# mogakkoroom3d

## 얼음땡 🧊

`npm run dev`는 Next.js 페이지(3000)와 WebSocket 방 서버(3001)를 함께 실행합니다.
첫 입장자가 방장이며, 퇴장하면 다음 입장자에게 권한이 넘어갑니다.
방장은 참여자 목록의 **👑 넘기기** 버튼으로 다른 참여자에게 권한을 넘길 수 있습니다. 게임 중에도 가능하며 술래와 남은 시간은 유지됩니다.

- 2명 이상 입장한 뒤 방장이 **얼음땡 시작**을 누르면 술래를 추첨하고 60초 동안 진행합니다.
- 대기 중 **술래 랜덤 배정**으로 별도 추첨도 가능합니다. 시작할 때는 다시 추첨합니다.
- **Shift + 이동**: 달리기. 스태미너는 약 5초 동안 사용할 수 있고 걷거나 멈추면 회복합니다.
- **F / 얼음 버튼**: 도망자가 얼음 상태가 됩니다. 이동과 점프가 제한되고 술래에게 잡히지 않습니다.
- **G / 땡 버튼**: 가까운 얼음 상태 동료 한 명을 구출합니다. 구출 후 1.5초간 보호됩니다.
- 술래가 얼지 않은 도망자에 닿으면 탈락합니다. 전원이 얼거나 탈락하면 술래 승리, 60초를 버티면 도망자 승리입니다.
- 시작 후 2초간 준비 보호가 적용됩니다. 게임 중에는 착석할 수 없습니다.
- 게임 도중 입장하거나 재연결한 참여자는 다음 판까지 관전합니다. 술래 이탈 또는 참여 인원 부족 시 게임이 취소됩니다.

규칙 테스트: `npm test`
