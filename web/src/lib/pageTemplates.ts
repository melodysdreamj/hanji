import { isKoreanLocale } from "./i18n";
import type { BlockContent, BlockType } from "./types";

export type PageTemplateBlock = {
  type: BlockType;
  content?: BlockContent;
  children?: PageTemplateBlock[];
};

export type PageTemplate = {
  id: string;
  title: string;
  description: string;
  category: string;
  icon: "doc" | "check" | "calendar" | "list" | "clock";
  pageIcon: string;
  blocks: PageTemplateBlock[];
};

type Lang = "en" | "ko";

function rich(text: string): BlockContent {
  return { rich: text ? [{ text }] : [] };
}

/** Guidance text the user is expected to overwrite — rendered gray like Notion sample content. */
function hint(text: string): BlockContent {
  return { rich: [{ text, color: "gray" }] };
}

function todo(text: string, checked = false): BlockContent {
  return { rich: text ? [{ text, ...(checked ? {} : { color: "gray" }) }] : [], checked };
}

function callout(text: string, icon: string, color?: string): BlockContent {
  return { rich: [{ text }], icon, ...(color ? { color } : {}) };
}

function table(rows: string[][], opts?: { headerRow?: boolean; headerColumn?: boolean }): BlockContent {
  return {
    table: rows,
    headerRow: opts?.headerRow ?? false,
    headerColumn: opts?.headerColumn ?? false,
  };
}

function b(type: BlockType, content?: BlockContent, children?: PageTemplateBlock[]): PageTemplateBlock {
  return children && children.length > 0 ? { type, content, children } : { type, content };
}

function buildTemplates(lang: Lang): PageTemplate[] {
  const t = (en: string, ko: string) => (lang === "ko" ? ko : en);

  return [
    {
      id: "journal",
      title: t("Journal", "일기"),
      description: t("Daily log with highlights and gratitude", "하이라이트와 감사로 하루를 기록"),
      category: t("Personal", "개인"),
      icon: "doc",
      pageIcon: "📓",
      blocks: [
        b("callout", callout(
          t(
            "Write freely — a few honest lines beat a perfect entry. Duplicate this page for each new day.",
            "형식에 얽매이지 말고 편하게 쓰세요. 완벽한 기록보다 솔직한 몇 줄이 낫습니다. 매일 이 페이지를 복제해서 쓰면 좋아요.",
          ),
          "💡",
          "gray_background",
        )),
        b("heading_2", rich(t("Today's log", "오늘의 기록"))),
        b("paragraph", hint(t("What happened today? How did it make you feel?", "오늘 무슨 일이 있었나요? 어떤 기분이 들었나요?"))),
        b("heading_2", rich(t("Highlights", "하이라이트"))),
        b("bulleted_list_item", hint(t("The best moment of the day", "오늘 가장 좋았던 순간"))),
        b("bulleted_list_item", hint(t("Something I learned", "새로 배운 것"))),
        b("heading_2", rich(t("Gratitude", "감사한 일"))),
        b("bulleted_list_item", hint(t("One thing I'm grateful for", "감사한 일 한 가지"))),
        b("divider"),
        b("heading_2", rich(t("Tomorrow", "내일"))),
        b("to_do", todo(t("Top priority for tomorrow", "내일 가장 중요한 일"))),
        b("to_do", todo("")),
      ],
    },
    {
      id: "task-list",
      title: t("Task List", "할 일 목록"),
      description: t("Today, this week, and a backlog", "오늘·이번 주·나중에로 나눈 할 일"),
      category: t("Personal", "개인"),
      icon: "check",
      pageIcon: "✅",
      blocks: [
        b("callout", callout(
          t(
            "Check items off as you go. Drag tasks between sections when plans change.",
            "완료하면 체크하고, 계획이 바뀌면 섹션 사이로 드래그하세요.",
          ),
          "💡",
          "gray_background",
        )),
        b("heading_2", rich(t("Today", "오늘"))),
        b("to_do", todo(t("Set up my task list", "할 일 목록 만들기"), true)),
        b("to_do", todo(t("Add today's most important task", "오늘 가장 중요한 일 추가하기"))),
        b("to_do", todo(t("Follow up on yesterday's leftovers", "어제 못 끝낸 일 마무리하기"))),
        b("heading_2", rich(t("This week", "이번 주"))),
        b("to_do", todo(t("Plan the week on Monday", "월요일에 한 주 계획 세우기"))),
        b("to_do", todo(t("Prepare for the next meeting", "다음 회의 준비하기"))),
        b("heading_2", rich(t("Later", "나중에"))),
        b("to_do", todo(t("Park future ideas here so they are not forgotten", "잊지 않도록 아이디어를 여기에 적어두기"))),
        b("divider"),
        b("heading_2", rich(t("Done", "완료"))),
        b("paragraph", hint(t(
          "Drag finished tasks here for a satisfying weekly review.",
          "끝낸 일을 이곳으로 옮겨 한 주를 돌아보세요.",
        ))),
      ],
    },
    {
      id: "habit-tracker",
      title: t("Habit Tracker", "습관 트래커"),
      description: t("Weekly grid with a built-in review", "주간 체크표와 돌아보기"),
      category: t("Personal", "개인"),
      icon: "check",
      pageIcon: "📈",
      blocks: [
        b("callout", callout(
          t(
            "Mark each cell with a ✓ as you go. Small streaks beat big plans.",
            "실천한 날의 칸에 ✓ 표시를 하세요. 거창한 계획보다 작은 연속이 힘이 셉니다.",
          ),
          "💡",
          "gray_background",
        )),
        b("heading_2", rich(t("This week", "이번 주"))),
        b("simple_table", table(
          [
            [t("Habit", "습관"), t("Mon", "월"), t("Tue", "화"), t("Wed", "수"), t("Thu", "목"), t("Fri", "금"), t("Sat", "토"), t("Sun", "일")],
            [t("Wake up early", "일찍 일어나기"), "", "", "", "", "", "", ""],
            [t("Exercise", "운동하기"), "", "", "", "", "", "", ""],
            [t("Read 20 minutes", "20분 독서"), "", "", "", "", "", "", ""],
            [t("Journal", "일기 쓰기"), "", "", "", "", "", "", ""],
          ],
          { headerRow: true, headerColumn: true },
        )),
        b("heading_2", rich(t("Weekly review", "주간 돌아보기"))),
        b(
          "toggle",
          rich(t("How did this week go?", "이번 주는 어땠나요?")),
          [
            b("bulleted_list_item", hint(t("Which habit was easiest to keep?", "가장 지키기 쉬웠던 습관은?"))),
            b("bulleted_list_item", hint(t("What got in the way?", "무엇이 방해가 되었나요?"))),
            b("bulleted_list_item", hint(t("One tweak for next week", "다음 주에 바꿔볼 한 가지"))),
          ],
        ),
        b("heading_2", rich(t("Notes", "메모"))),
        b("paragraph", rich("")),
      ],
    },
    {
      id: "reading-list",
      title: t("Reading List", "독서 목록"),
      description: t("Now reading, queue, and favorite quotes", "읽는 중·읽을 예정·인상 깊은 문장"),
      category: t("Personal", "개인"),
      icon: "list",
      pageIcon: "📚",
      blocks: [
        b("callout", callout(
          t(
            "Keep everything you want to read in one place. Move items up as you start them.",
            "읽고 싶은 것을 모두 한곳에 모아두고, 읽기 시작하면 위로 올리세요.",
          ),
          "💡",
          "gray_background",
        )),
        b("heading_2", rich(t("Reading now", "읽는 중"))),
        b(
          "bulleted_list_item",
          hint(t("Book title — author", "책 제목 — 지은이")),
          [b("bulleted_list_item", hint(t("Where I stopped, and a thought so far", "어디까지 읽었는지, 지금까지의 감상")))],
        ),
        b("heading_2", rich(t("Queue", "읽을 예정"))),
        b("to_do", todo(t("Next book or article", "다음에 읽을 책이나 글"))),
        b("to_do", todo(t("A recommendation from a friend", "친구가 추천해 준 것"))),
        b("heading_2", rich(t("Finished", "다 읽음"))),
        b("to_do", todo(t("An example finished read — add a one-line review", "다 읽은 책 예시 — 한 줄 평을 남겨보세요"), true)),
        b("heading_2", rich(t("Favorite quotes", "인상 깊은 문장"))),
        b("quote", hint(t("Copy a line that stuck with you", "마음에 남은 문장을 옮겨 적어보세요"))),
      ],
    },
    {
      id: "meeting-notes",
      title: t("Meeting Notes", "회의록"),
      description: t("Agenda, decisions, and owned action items", "안건·결정 사항·담당자별 액션 아이템"),
      category: t("Work", "업무"),
      icon: "calendar",
      pageIcon: "🗓️",
      blocks: [
        b("callout", callout(
          t(
            "One page per meeting. Give every action item an owner before the meeting ends.",
            "회의마다 한 페이지씩 쓰세요. 회의가 끝나기 전에 액션 아이템마다 담당자를 정하세요.",
          ),
          "💡",
          "gray_background",
        )),
        b("simple_table", table(
          [
            [t("Date", "일시"), ""],
            [t("Attendees", "참석자"), ""],
            [t("Location", "장소"), ""],
          ],
          { headerColumn: true },
        )),
        b("heading_2", rich(t("Agenda", "안건"))),
        b("numbered_list_item", hint(t("First topic to discuss", "첫 번째 논의 주제"))),
        b("numbered_list_item", hint(t("Second topic to discuss", "두 번째 논의 주제"))),
        b("heading_2", rich(t("Notes", "논의 내용"))),
        b("bulleted_list_item", hint(t("Key points, context, and open discussion", "핵심 논의와 배경, 열린 질문"))),
        b("heading_2", rich(t("Decisions", "결정 사항"))),
        b("callout", callout(t("What was decided, and why", "무엇을, 왜 결정했는지"), "✅", "green_background")),
        b("heading_2", rich(t("Action items", "액션 아이템"))),
        b("to_do", todo(t("Owner — task and due date", "담당자 — 할 일과 기한"))),
        b("to_do", todo(t("Owner — task and due date", "담당자 — 할 일과 기한"))),
        b("heading_2", rich(t("Next meeting", "다음 회의"))),
        b("paragraph", hint(t("Date and topics to carry over", "다음 일정과 이월할 안건"))),
      ],
    },
    {
      id: "one-on-one",
      title: t("1:1 Notes", "1:1 미팅"),
      description: t("Running page for recurring one-on-ones", "정기 1:1을 이어 적는 페이지"),
      category: t("Work", "업무"),
      icon: "calendar",
      pageIcon: "🤝",
      blocks: [
        b("callout", callout(
          t(
            "A running page for recurring 1:1s — add a new date heading on top each time.",
            "정기 1:1을 이어서 기록하는 페이지예요. 매번 맨 위에 새 날짜 제목을 추가하세요.",
          ),
          "💡",
          "gray_background",
        )),
        b("heading_2", rich(t("Talking points", "이야기할 것"))),
        b("heading_3", rich(t("Their topics", "상대방 안건"))),
        b("bulleted_list_item", hint(t("What do they want to cover?", "상대방이 다루고 싶은 주제"))),
        b("heading_3", rich(t("My topics", "내 안건"))),
        b("bulleted_list_item", hint(t("What do I want to cover?", "내가 다루고 싶은 주제"))),
        b("heading_2", rich(t("Wins since last time", "지난번 이후 잘된 일"))),
        b("bulleted_list_item", hint(t("Something worth celebrating", "축하할 만한 일"))),
        b("heading_2", rich(t("Feedback", "피드백"))),
        b("bulleted_list_item", hint(t("One thing to keep, one thing to adjust", "계속하면 좋은 것 하나, 바꾸면 좋은 것 하나"))),
        b("heading_2", rich(t("Growth & career", "성장과 커리어"))),
        b("paragraph", hint(t("Longer-term goals — revisit once a month", "장기 목표 — 한 달에 한 번 다시 살펴보세요"))),
        b("heading_2", rich(t("Action items", "액션 아이템"))),
        b("to_do", todo(t("Mine — what I committed to", "내 것 — 내가 하기로 한 일"))),
        b("to_do", todo(t("Theirs — what they committed to", "상대방 — 상대방이 하기로 한 일"))),
      ],
    },
    {
      id: "project-brief",
      title: t("Project Brief", "프로젝트 개요"),
      description: t("Goals, scope, milestones, and risks", "목표·범위·마일스톤·리스크"),
      category: t("Work", "업무"),
      icon: "doc",
      pageIcon: "📄",
      blocks: [
        b("callout", callout(
          t(
            "Fill in the one-line summary first. If you can't, the project isn't defined yet.",
            "한 줄 요약부터 채우세요. 요약이 안 되면 아직 프로젝트가 정의되지 않은 것입니다.",
          ),
          "💡",
          "gray_background",
        )),
        b("heading_2", rich(t("Overview", "개요"))),
        b("paragraph", hint(t("What are we doing, for whom, and why now?", "무엇을, 누구를 위해, 왜 지금 하나요?"))),
        b("heading_2", rich(t("Goals", "목표"))),
        b("simple_table", table(
          [
            [t("Metric", "지표"), t("Baseline", "현재"), t("Target", "목표")],
            [t("e.g. Weekly active users", "예: 주간 활성 사용자"), "", ""],
          ],
          { headerRow: true },
        )),
        b("heading_2", rich(t("Scope", "범위"))),
        b("heading_3", rich(t("In scope", "포함"))),
        b("bulleted_list_item", hint(t("What this project will deliver", "이번에 만들 것"))),
        b("heading_3", rich(t("Out of scope", "제외"))),
        b("bulleted_list_item", hint(t("Explicitly excluded — this is what prevents scope creep", "명시적으로 제외한 것 — 범위가 늘어나는 걸 막아줍니다"))),
        b("heading_2", rich(t("Milestones", "마일스톤"))),
        b("simple_table", table(
          [
            [t("Milestone", "마일스톤"), t("Owner", "담당"), t("Date", "일정")],
            [t("Kickoff", "킥오프"), "", ""],
            [t("First review", "1차 리뷰"), "", ""],
          ],
          { headerRow: true },
        )),
        b("heading_2", rich(t("Risks", "리스크"))),
        b(
          "toggle",
          rich(t("What could go wrong?", "무엇이 잘못될 수 있나요?")),
          [b("bulleted_list_item", hint(t("Risk — and how we'll mitigate it", "리스크 — 그리고 대비 방법")))],
        ),
        b("heading_2", rich(t("Team", "팀"))),
        b("bulleted_list_item", hint(t("Role — name", "역할 — 이름"))),
      ],
    },
    {
      id: "product-spec",
      title: t("Product Spec", "제품 스펙"),
      description: t("Problem, requirements, and launch checklist", "문제 정의·요구사항·출시 체크리스트"),
      category: t("Work", "업무"),
      icon: "doc",
      pageIcon: "🧩",
      blocks: [
        b("callout", callout(
          t(
            "Specs are for alignment, not paperwork — keep every section short enough to read in a minute.",
            "스펙은 서류 작업이 아니라 합의를 위한 것입니다. 각 섹션은 1분 안에 읽히도록 짧게 유지하세요.",
          ),
          "💡",
          "gray_background",
        )),
        b("heading_2", rich(t("Problem", "문제"))),
        b("paragraph", hint(t("Who is hurting today, and how do we know?", "지금 누가 불편을 겪고 있고, 그것을 어떻게 아나요?"))),
        b("heading_2", rich(t("Goals", "목표"))),
        b("bulleted_list_item", hint(t("A measurable outcome", "측정 가능한 결과"))),
        b("bulleted_list_item", hint(t("Another measurable outcome", "또 다른 측정 가능한 결과"))),
        b("heading_2", rich(t("Non-goals", "하지 않을 것"))),
        b("bulleted_list_item", hint(t("What this deliberately won't do", "이번에 의도적으로 하지 않는 것"))),
        b("heading_2", rich(t("User story", "사용자 스토리"))),
        b("quote", hint(t("As a ___, I want ___ so that ___.", "___로서, ___하고 싶다. 그래서 ___할 수 있다."))),
        b("heading_2", rich(t("Requirements", "요구사항"))),
        b("heading_3", rich(t("Must have", "필수"))),
        b("to_do", todo(t("A requirement the launch blocks on", "출시에 반드시 필요한 요구사항"))),
        b("to_do", todo(t("Another blocking requirement", "또 다른 필수 요구사항"))),
        b("heading_3", rich(t("Nice to have", "있으면 좋음"))),
        b("to_do", todo(t("Worth doing if time allows", "시간이 되면 할 만한 것"))),
        b("heading_2", rich(t("Open questions", "미해결 질문"))),
        b("bulleted_list_item", hint(t("What still needs an answer, and from whom?", "아직 답이 필요한 것과 누가 답해줄지"))),
        b("heading_2", rich(t("Launch checklist", "출시 체크리스트"))),
        b(
          "toggle",
          rich(t("Before we ship", "출시 전에")),
          [
            b("to_do", todo(t("Docs updated", "문서 업데이트"))),
            b("to_do", todo(t("Metrics dashboard ready", "지표 대시보드 준비"))),
            b("to_do", todo(t("Rollback plan written", "롤백 계획 작성"))),
          ],
        ),
      ],
    },
    {
      id: "decision-log",
      title: t("Decision Log", "의사결정 기록"),
      description: t("Context, options compared, and consequences", "배경·선택지 비교·영향"),
      category: t("Work", "업무"),
      icon: "list",
      pageIcon: "⚖️",
      blocks: [
        b("callout", callout(
          t(
            "Write decisions down when they're made — future you will ask why.",
            "결정은 내린 그 자리에서 기록하세요. 미래의 내가 그 이유를 물어봅니다.",
          ),
          "💡",
          "gray_background",
        )),
        b("paragraph", {
          rich: [
            { text: t("Status: ", "상태: "), bold: true },
            { text: t("Proposed · Accepted · Superseded", "제안됨 · 승인됨 · 대체됨"), color: "gray" },
          ],
        }),
        b("heading_2", rich(t("Decision", "결정"))),
        b("callout", callout(t("One sentence — what we decided", "무엇을 결정했는지 한 문장으로"), "⚖️", "blue_background")),
        b("heading_2", rich(t("Context", "배경"))),
        b("paragraph", hint(t("The situation and constraints at the time", "당시의 상황과 제약"))),
        b("heading_2", rich(t("Options considered", "검토한 선택지"))),
        b("simple_table", table(
          [
            [t("Option", "선택지"), t("Pros", "장점"), t("Cons", "단점")],
            [t("Option A", "A안"), "", ""],
            [t("Option B", "B안"), "", ""],
          ],
          { headerRow: true },
        )),
        b("heading_2", rich(t("Consequences", "영향"))),
        b("bulleted_list_item", hint(t("What this makes easier, and what it makes harder", "이 결정으로 쉬워지는 것과 어려워지는 것"))),
        b("heading_2", rich(t("Follow-ups", "후속 작업"))),
        b("to_do", todo(t("Owner — follow-up task", "담당자 — 후속 할 일"))),
      ],
    },
    {
      id: "weekly-plan",
      title: t("Weekly Plan", "주간 계획"),
      description: t("Three priorities and a day-by-day schedule", "3대 우선순위와 요일별 일정"),
      category: t("Personal", "개인"),
      icon: "clock",
      pageIcon: "⏱️",
      blocks: [
        b("callout", callout(
          t(
            "Plan on Monday, review on Friday. Three priorities beat ten.",
            "월요일에 계획하고 금요일에 돌아보세요. 우선순위는 열 개보다 세 개가 낫습니다.",
          ),
          "💡",
          "gray_background",
        )),
        b("heading_2", rich(t("Top priorities", "최우선 과제"))),
        b("numbered_list_item", hint(t("Must finish this week", "이번 주에 꼭 끝낼 일"))),
        b("numbered_list_item", hint(t("Second priority", "두 번째 우선순위"))),
        b("numbered_list_item", hint(t("Third priority", "세 번째 우선순위"))),
        b("heading_2", rich(t("Schedule", "주간 일정"))),
        b("simple_table", table(
          [
            [t("Day", "요일"), t("Focus", "집중할 일"), t("Notes", "메모")],
            [t("Mon", "월"), "", ""],
            [t("Tue", "화"), "", ""],
            [t("Wed", "수"), "", ""],
            [t("Thu", "목"), "", ""],
            [t("Fri", "금"), "", ""],
          ],
          { headerRow: true, headerColumn: true },
        )),
        b("heading_2", rich(t("Friday review", "금요일 회고"))),
        b(
          "toggle",
          rich(t("How did the week go?", "이번 주는 어땠나요?")),
          [
            b("bulleted_list_item", hint(t("What got done?", "끝낸 일은?"))),
            b("bulleted_list_item", hint(t("What moves to next week?", "다음 주로 넘길 일은?"))),
          ],
        ),
      ],
    },
    {
      id: "class-notes",
      title: t("Class Notes", "수업 노트"),
      description: t("Key ideas, vocabulary, and review questions", "핵심 개념·용어 정리·복습 질문"),
      category: t("Education", "학습"),
      icon: "doc",
      pageIcon: "🎓",
      blocks: [
        b("callout", callout(
          t(
            "Write questions in your own words while you listen, and review them within a day.",
            "수업을 들으면서 내 말로 질문을 적어두고, 하루 안에 복습하세요.",
          ),
          "💡",
          "gray_background",
        )),
        b("simple_table", table(
          [
            [t("Course", "과목"), ""],
            [t("Date", "날짜"), ""],
            [t("Topic", "주제"), ""],
          ],
          { headerColumn: true },
        )),
        b("heading_2", rich(t("Key ideas", "핵심 개념"))),
        b("bulleted_list_item", hint(t("The main concept, in my own words", "핵심 개념을 내 말로"))),
        b("bulleted_list_item", hint(t("How it connects to what I already know", "이미 아는 것과의 연결"))),
        b("heading_2", rich(t("Notes", "필기"))),
        b("paragraph", rich("")),
        b("heading_2", rich(t("Vocabulary", "용어 정리"))),
        b("simple_table", table(
          [
            [t("Term", "용어"), t("Meaning", "뜻")],
            ["", ""],
            ["", ""],
          ],
          { headerRow: true },
        )),
        b("heading_2", rich(t("Questions to review", "복습할 질문"))),
        b("to_do", todo(t("Something I didn't fully understand", "완전히 이해하지 못한 것"))),
        b("to_do", todo(t("A likely exam question", "시험에 나올 만한 질문"))),
        b("heading_2", rich(t("Summary", "요약"))),
        b("paragraph", hint(t("Three sentences, from memory", "기억만으로 세 문장 요약"))),
      ],
    },
    {
      id: "research-notes",
      title: t("Research Notes", "리서치 노트"),
      description: t("Source, quotes, and your own analysis", "출처·인용·나의 분석"),
      category: t("Education", "학습"),
      icon: "doc",
      pageIcon: "🔎",
      blocks: [
        b("callout", callout(
          t(
            "One page per source. Keep what the source says separate from what you think.",
            "출처마다 한 페이지씩 쓰세요. 출처의 주장과 내 생각을 구분해 두세요.",
          ),
          "💡",
          "gray_background",
        )),
        b("simple_table", table(
          [
            [t("Title", "제목"), ""],
            [t("Author", "저자"), ""],
            [t("Link", "링크"), ""],
            [t("Accessed", "확인한 날짜"), ""],
          ],
          { headerColumn: true },
        )),
        b("heading_2", rich(t("Summary", "요약"))),
        b("paragraph", hint(t("The argument in two or three sentences", "핵심 주장을 두세 문장으로"))),
        b("heading_2", rich(t("Key quotes", "주요 인용"))),
        b("quote", hint(t("Exact words, with the page number", "쪽수와 함께 원문 그대로"))),
        b("heading_2", rich(t("My thoughts", "내 생각"))),
        b("bulleted_list_item", hint(t("Where I agree or disagree, and why", "어디에 동의하고 반대하는지, 그 이유"))),
        b("bulleted_list_item", hint(t("Connections to other sources", "다른 자료와의 연결"))),
        b("heading_2", rich(t("Next steps", "다음 할 일"))),
        b("to_do", todo(t("Follow a citation", "인용된 자료 따라가기"))),
        b("to_do", todo(t("Find a counter-argument", "반대 근거 찾아보기"))),
      ],
    },
  ];
}

let cachedLang: Lang | null = null;
let cachedTemplates: PageTemplate[] = [];

export function pageTemplates(): PageTemplate[] {
  const lang: Lang = isKoreanLocale() ? "ko" : "en";
  if (cachedLang !== lang) {
    cachedTemplates = buildTemplates(lang);
    cachedLang = lang;
  }
  return cachedTemplates;
}
