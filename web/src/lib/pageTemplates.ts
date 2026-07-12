import { i18next } from "@/i18n";
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

function buildTemplates(): PageTemplate[] {
  // Resolved at call time so i18next is initialized before the keys are read.
  const t = (key: string): string => i18next.t(`pageTemplates:${key}`);

  return [
    {
      id: "journal",
      title: t("journal.title"),
      description: t("journal.description"),
      category: t("categories.personal"),
      icon: "doc",
      pageIcon: "📓",
      blocks: [
        b("callout", callout(t("journal.callout"), "💡", "gray_background")),
        b("heading_2", rich(t("journal.todaysLogHeading"))),
        b("paragraph", hint(t("journal.todaysLogHint"))),
        b("heading_2", rich(t("journal.highlightsHeading"))),
        b("bulleted_list_item", hint(t("journal.highlightBest"))),
        b("bulleted_list_item", hint(t("journal.highlightLearned"))),
        b("heading_2", rich(t("journal.gratitudeHeading"))),
        b("bulleted_list_item", hint(t("journal.gratitudeHint"))),
        b("divider"),
        b("heading_2", rich(t("journal.tomorrowHeading"))),
        b("to_do", todo(t("journal.tomorrowTodo"))),
        b("to_do", todo("")),
      ],
    },
    {
      id: "task-list",
      title: t("taskList.title"),
      description: t("taskList.description"),
      category: t("categories.personal"),
      icon: "check",
      pageIcon: "✅",
      blocks: [
        b("callout", callout(t("taskList.callout"), "💡", "gray_background")),
        b("heading_2", rich(t("taskList.todayHeading"))),
        b("to_do", todo(t("taskList.todaySetup"), true)),
        b("to_do", todo(t("taskList.todayImportant"))),
        b("to_do", todo(t("taskList.todayFollowUp"))),
        b("heading_2", rich(t("taskList.thisWeekHeading"))),
        b("to_do", todo(t("taskList.thisWeekPlan"))),
        b("to_do", todo(t("taskList.thisWeekPrepare"))),
        b("heading_2", rich(t("taskList.laterHeading"))),
        b("to_do", todo(t("taskList.laterPark"))),
        b("divider"),
        b("heading_2", rich(i18next.t("common:actions.done"))),
        b("paragraph", hint(t("taskList.doneHint"))),
      ],
    },
    {
      id: "habit-tracker",
      title: t("habitTracker.title"),
      description: t("habitTracker.description"),
      category: t("categories.personal"),
      icon: "check",
      pageIcon: "📈",
      blocks: [
        b("callout", callout(t("habitTracker.callout"), "💡", "gray_background")),
        b("heading_2", rich(t("habitTracker.thisWeekHeading"))),
        b("simple_table", table(
          [
            [t("habitTracker.colHabit"), t("habitTracker.colMon"), t("habitTracker.colTue"), t("habitTracker.colWed"), t("habitTracker.colThu"), t("habitTracker.colFri"), t("habitTracker.colSat"), t("habitTracker.colSun")],
            [t("habitTracker.rowWakeEarly"), "", "", "", "", "", "", ""],
            [t("habitTracker.rowExercise"), "", "", "", "", "", "", ""],
            [t("habitTracker.rowRead"), "", "", "", "", "", "", ""],
            [t("habitTracker.rowJournal"), "", "", "", "", "", "", ""],
          ],
          { headerRow: true, headerColumn: true },
        )),
        b("heading_2", rich(t("habitTracker.reviewHeading"))),
        b(
          "toggle",
          rich(t("habitTracker.reviewToggle")),
          [
            b("bulleted_list_item", hint(t("habitTracker.reviewEasiest"))),
            b("bulleted_list_item", hint(t("habitTracker.reviewObstacle"))),
            b("bulleted_list_item", hint(t("habitTracker.reviewTweak"))),
          ],
        ),
        b("heading_2", rich(t("habitTracker.notesHeading"))),
        b("paragraph", rich("")),
      ],
    },
    {
      id: "reading-list",
      title: t("readingList.title"),
      description: t("readingList.description"),
      category: t("categories.personal"),
      icon: "list",
      pageIcon: "📚",
      blocks: [
        b("callout", callout(t("readingList.callout"), "💡", "gray_background")),
        b("heading_2", rich(t("readingList.readingNowHeading"))),
        b(
          "bulleted_list_item",
          hint(t("readingList.readingNowItem")),
          [b("bulleted_list_item", hint(t("readingList.readingNowChild")))],
        ),
        b("heading_2", rich(t("readingList.queueHeading"))),
        b("to_do", todo(t("readingList.queueNext"))),
        b("to_do", todo(t("readingList.queueRecommendation"))),
        b("heading_2", rich(t("readingList.finishedHeading"))),
        b("to_do", todo(t("readingList.finishedItem"), true)),
        b("heading_2", rich(t("readingList.quotesHeading"))),
        b("quote", hint(t("readingList.quotesHint"))),
      ],
    },
    {
      id: "meeting-notes",
      title: t("meetingNotes.title"),
      description: t("meetingNotes.description"),
      category: t("categories.work"),
      icon: "calendar",
      pageIcon: "🗓️",
      blocks: [
        b("callout", callout(t("meetingNotes.callout"), "💡", "gray_background")),
        b("simple_table", table(
          [
            [t("meetingNotes.rowDate"), ""],
            [t("meetingNotes.rowAttendees"), ""],
            [t("meetingNotes.rowLocation"), ""],
          ],
          { headerColumn: true },
        )),
        b("heading_2", rich(t("meetingNotes.agendaHeading"))),
        b("numbered_list_item", hint(t("meetingNotes.agendaFirst"))),
        b("numbered_list_item", hint(t("meetingNotes.agendaSecond"))),
        b("heading_2", rich(t("meetingNotes.notesHeading"))),
        b("bulleted_list_item", hint(t("meetingNotes.notesHint"))),
        b("heading_2", rich(t("meetingNotes.decisionsHeading"))),
        b("callout", callout(t("meetingNotes.decisionsCallout"), "✅", "green_background")),
        b("heading_2", rich(t("meetingNotes.actionItemsHeading"))),
        b("to_do", todo(t("meetingNotes.actionItemTodo"))),
        b("to_do", todo(t("meetingNotes.actionItemTodo"))),
        b("heading_2", rich(t("meetingNotes.nextMeetingHeading"))),
        b("paragraph", hint(t("meetingNotes.nextMeetingHint"))),
      ],
    },
    {
      id: "one-on-one",
      title: t("oneOnOne.title"),
      description: t("oneOnOne.description"),
      category: t("categories.work"),
      icon: "calendar",
      pageIcon: "🤝",
      blocks: [
        b("callout", callout(t("oneOnOne.callout"), "💡", "gray_background")),
        b("heading_2", rich(t("oneOnOne.talkingPointsHeading"))),
        b("heading_3", rich(t("oneOnOne.theirTopicsHeading"))),
        b("bulleted_list_item", hint(t("oneOnOne.theirTopicsHint"))),
        b("heading_3", rich(t("oneOnOne.myTopicsHeading"))),
        b("bulleted_list_item", hint(t("oneOnOne.myTopicsHint"))),
        b("heading_2", rich(t("oneOnOne.winsHeading"))),
        b("bulleted_list_item", hint(t("oneOnOne.winsHint"))),
        b("heading_2", rich(t("oneOnOne.feedbackHeading"))),
        b("bulleted_list_item", hint(t("oneOnOne.feedbackHint"))),
        b("heading_2", rich(t("oneOnOne.growthHeading"))),
        b("paragraph", hint(t("oneOnOne.growthHint"))),
        b("heading_2", rich(t("oneOnOne.actionItemsHeading"))),
        b("to_do", todo(t("oneOnOne.actionItemMine"))),
        b("to_do", todo(t("oneOnOne.actionItemTheirs"))),
      ],
    },
    {
      id: "project-brief",
      title: t("projectBrief.title"),
      description: t("projectBrief.description"),
      category: t("categories.work"),
      icon: "doc",
      pageIcon: "📄",
      blocks: [
        b("callout", callout(t("projectBrief.callout"), "💡", "gray_background")),
        b("heading_2", rich(t("projectBrief.overviewHeading"))),
        b("paragraph", hint(t("projectBrief.overviewHint"))),
        b("heading_2", rich(t("projectBrief.goalsHeading"))),
        b("simple_table", table(
          [
            [t("projectBrief.goalsMetric"), t("projectBrief.goalsBaseline"), t("projectBrief.goalsTarget")],
            [t("projectBrief.goalsExample"), "", ""],
          ],
          { headerRow: true },
        )),
        b("heading_2", rich(t("projectBrief.scopeHeading"))),
        b("heading_3", rich(t("projectBrief.inScopeHeading"))),
        b("bulleted_list_item", hint(t("projectBrief.inScopeHint"))),
        b("heading_3", rich(t("projectBrief.outScopeHeading"))),
        b("bulleted_list_item", hint(t("projectBrief.outScopeHint"))),
        b("heading_2", rich(t("projectBrief.milestonesHeading"))),
        b("simple_table", table(
          [
            [t("projectBrief.milestoneCol"), t("projectBrief.milestoneOwner"), t("projectBrief.milestoneDate")],
            [t("projectBrief.milestoneKickoff"), "", ""],
            [t("projectBrief.milestoneFirstReview"), "", ""],
          ],
          { headerRow: true },
        )),
        b("heading_2", rich(t("projectBrief.risksHeading"))),
        b(
          "toggle",
          rich(t("projectBrief.risksToggle")),
          [b("bulleted_list_item", hint(t("projectBrief.risksHint")))],
        ),
        b("heading_2", rich(t("projectBrief.teamHeading"))),
        b("bulleted_list_item", hint(t("projectBrief.teamHint"))),
      ],
    },
    {
      id: "product-spec",
      title: t("productSpec.title"),
      description: t("productSpec.description"),
      category: t("categories.work"),
      icon: "doc",
      pageIcon: "🧩",
      blocks: [
        b("callout", callout(t("productSpec.callout"), "💡", "gray_background")),
        b("heading_2", rich(t("productSpec.problemHeading"))),
        b("paragraph", hint(t("productSpec.problemHint"))),
        b("heading_2", rich(t("productSpec.goalsHeading"))),
        b("bulleted_list_item", hint(t("productSpec.goalMeasurable"))),
        b("bulleted_list_item", hint(t("productSpec.goalMeasurableOther"))),
        b("heading_2", rich(t("productSpec.nonGoalsHeading"))),
        b("bulleted_list_item", hint(t("productSpec.nonGoalsHint"))),
        b("heading_2", rich(t("productSpec.userStoryHeading"))),
        b("quote", hint(t("productSpec.userStoryHint"))),
        b("heading_2", rich(t("productSpec.requirementsHeading"))),
        b("heading_3", rich(t("productSpec.mustHaveHeading"))),
        b("to_do", todo(t("productSpec.mustHaveTodo"))),
        b("to_do", todo(t("productSpec.mustHaveTodoOther"))),
        b("heading_3", rich(t("productSpec.niceToHaveHeading"))),
        b("to_do", todo(t("productSpec.niceToHaveTodo"))),
        b("heading_2", rich(t("productSpec.openQuestionsHeading"))),
        b("bulleted_list_item", hint(t("productSpec.openQuestionsHint"))),
        b("heading_2", rich(t("productSpec.launchChecklistHeading"))),
        b(
          "toggle",
          rich(t("productSpec.launchToggle")),
          [
            b("to_do", todo(t("productSpec.launchDocs"))),
            b("to_do", todo(t("productSpec.launchMetrics"))),
            b("to_do", todo(t("productSpec.launchRollback"))),
          ],
        ),
      ],
    },
    {
      id: "decision-log",
      title: t("decisionLog.title"),
      description: t("decisionLog.description"),
      category: t("categories.work"),
      icon: "list",
      pageIcon: "⚖️",
      blocks: [
        b("callout", callout(t("decisionLog.callout"), "💡", "gray_background")),
        b("paragraph", {
          rich: [
            { text: t("decisionLog.statusLabel"), bold: true },
            { text: t("decisionLog.statusValue"), color: "gray" },
          ],
        }),
        b("heading_2", rich(t("decisionLog.decisionHeading"))),
        b("callout", callout(t("decisionLog.decisionCallout"), "⚖️", "blue_background")),
        b("heading_2", rich(t("decisionLog.contextHeading"))),
        b("paragraph", hint(t("decisionLog.contextHint"))),
        b("heading_2", rich(t("decisionLog.optionsHeading"))),
        b("simple_table", table(
          [
            [t("decisionLog.colOption"), t("decisionLog.colPros"), t("decisionLog.colCons")],
            [t("decisionLog.optionA"), "", ""],
            [t("decisionLog.optionB"), "", ""],
          ],
          { headerRow: true },
        )),
        b("heading_2", rich(t("decisionLog.consequencesHeading"))),
        b("bulleted_list_item", hint(t("decisionLog.consequencesHint"))),
        b("heading_2", rich(t("decisionLog.followUpsHeading"))),
        b("to_do", todo(t("decisionLog.followUpTodo"))),
      ],
    },
    {
      id: "weekly-plan",
      title: t("weeklyPlan.title"),
      description: t("weeklyPlan.description"),
      category: t("categories.personal"),
      icon: "clock",
      pageIcon: "⏱️",
      blocks: [
        b("callout", callout(t("weeklyPlan.callout"), "💡", "gray_background")),
        b("heading_2", rich(t("weeklyPlan.prioritiesHeading"))),
        b("numbered_list_item", hint(t("weeklyPlan.priorityFirst"))),
        b("numbered_list_item", hint(t("weeklyPlan.prioritySecond"))),
        b("numbered_list_item", hint(t("weeklyPlan.priorityThird"))),
        b("heading_2", rich(t("weeklyPlan.scheduleHeading"))),
        b("simple_table", table(
          [
            [t("weeklyPlan.colDay"), t("weeklyPlan.colFocus"), t("weeklyPlan.colNotes")],
            [t("weeklyPlan.dayMon"), "", ""],
            [t("weeklyPlan.dayTue"), "", ""],
            [t("weeklyPlan.dayWed"), "", ""],
            [t("weeklyPlan.dayThu"), "", ""],
            [t("weeklyPlan.dayFri"), "", ""],
          ],
          { headerRow: true, headerColumn: true },
        )),
        b("heading_2", rich(t("weeklyPlan.reviewHeading"))),
        b(
          "toggle",
          rich(t("weeklyPlan.reviewToggle")),
          [
            b("bulleted_list_item", hint(t("weeklyPlan.reviewDone"))),
            b("bulleted_list_item", hint(t("weeklyPlan.reviewNextWeek"))),
          ],
        ),
      ],
    },
    {
      id: "class-notes",
      title: t("classNotes.title"),
      description: t("classNotes.description"),
      category: t("categories.education"),
      icon: "doc",
      pageIcon: "🎓",
      blocks: [
        b("callout", callout(t("classNotes.callout"), "💡", "gray_background")),
        b("simple_table", table(
          [
            [t("classNotes.rowCourse"), ""],
            [t("classNotes.rowDate"), ""],
            [t("classNotes.rowTopic"), ""],
          ],
          { headerColumn: true },
        )),
        b("heading_2", rich(t("classNotes.keyIdeasHeading"))),
        b("bulleted_list_item", hint(t("classNotes.keyIdeaMain"))),
        b("bulleted_list_item", hint(t("classNotes.keyIdeaConnect"))),
        b("heading_2", rich(t("classNotes.notesHeading"))),
        b("paragraph", rich("")),
        b("heading_2", rich(t("classNotes.vocabularyHeading"))),
        b("simple_table", table(
          [
            [t("classNotes.colTerm"), t("classNotes.colMeaning")],
            ["", ""],
            ["", ""],
          ],
          { headerRow: true },
        )),
        b("heading_2", rich(t("classNotes.reviewHeading"))),
        b("to_do", todo(t("classNotes.reviewMisunderstood"))),
        b("to_do", todo(t("classNotes.reviewExam"))),
        b("heading_2", rich(t("classNotes.summaryHeading"))),
        b("paragraph", hint(t("classNotes.summaryHint"))),
      ],
    },
    {
      id: "research-notes",
      title: t("researchNotes.title"),
      description: t("researchNotes.description"),
      category: t("categories.education"),
      icon: "doc",
      pageIcon: "🔎",
      blocks: [
        b("callout", callout(t("researchNotes.callout"), "💡", "gray_background")),
        b("simple_table", table(
          [
            [t("researchNotes.rowTitle"), ""],
            [t("researchNotes.rowAuthor"), ""],
            [t("researchNotes.rowLink"), ""],
            [t("researchNotes.rowAccessed"), ""],
          ],
          { headerColumn: true },
        )),
        b("heading_2", rich(t("researchNotes.summaryHeading"))),
        b("paragraph", hint(t("researchNotes.summaryHint"))),
        b("heading_2", rich(t("researchNotes.quotesHeading"))),
        b("quote", hint(t("researchNotes.quotesHint"))),
        b("heading_2", rich(t("researchNotes.thoughtsHeading"))),
        b("bulleted_list_item", hint(t("researchNotes.thoughtsAgree"))),
        b("bulleted_list_item", hint(t("researchNotes.thoughtsConnections"))),
        b("heading_2", rich(t("researchNotes.nextStepsHeading"))),
        b("to_do", todo(t("researchNotes.nextStepCitation"))),
        b("to_do", todo(t("researchNotes.nextStepCounter"))),
      ],
    },
  ];
}

let cachedLang: string | null = null;
let cachedTemplates: PageTemplate[] = [];

export function pageTemplates(): PageTemplate[] {
  const lang = i18next.language || "en";
  if (cachedLang !== lang) {
    cachedTemplates = buildTemplates();
    cachedLang = lang;
  }
  return cachedTemplates;
}
