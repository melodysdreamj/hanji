import {
  Bell as PhosphorBell,
  Books as PhosphorBooks,
  CalendarBlank as PhosphorCalendarBlank,
  CaretDoubleLeft as PhosphorCaretDoubleLeft,
  CaretDoubleRight as PhosphorCaretDoubleRight,
  CaretDown as PhosphorCaretDown,
  CaretLeft as PhosphorCaretLeft,
  CaretRight as PhosphorCaretRight,
  CaretUp as PhosphorCaretUp,
  Check as PhosphorCheck,
  ChartBar as PhosphorChartBar,
  ChatTeardropText as PhosphorChatTeardropText,
  Clock as PhosphorClock,
  Code as PhosphorCode,
  Columns as PhosphorColumns,
  CopySimple as PhosphorCopySimple,
  Database as PhosphorDatabase,
  DotsSixVertical as PhosphorDotsSixVertical,
  DotsThree as PhosphorDotsThree,
  DownloadSimple as PhosphorDownloadSimple,
  Eye as PhosphorEye,
  EyeSlash as PhosphorEyeSlash,
  FileText as PhosphorFileText,
  GearSix as PhosphorGearSix,
  Globe as PhosphorGlobe,
  House as PhosphorHouse,
  LinkSimple as PhosphorLinkSimple,
  ListBullets as PhosphorListBullets,
  ListNumbers as PhosphorListNumbers,
  LockSimple as PhosphorLockSimple,
  LockSimpleOpen as PhosphorLockSimpleOpen,
  MagnifyingGlass as PhosphorMagnifyingGlass,
  MathOperations as PhosphorMathOperations,
  Minus as PhosphorMinus,
  Pause as PhosphorPause,
  Play as PhosphorPlay,
  ArrowSquareOut as PhosphorArrowSquareOut,
  Plus as PhosphorPlus2,
  Quotes as PhosphorQuotes,
  SidebarSimple as PhosphorSidebarSimple,
  SpeakerHigh as PhosphorSpeakerHigh,
  Star as PhosphorStar,
  TextHOne as PhosphorTextHOne,
  TextHThree as PhosphorTextHThree,
  TextHTwo as PhosphorTextHTwo,
  TextT as PhosphorTextT,
  TrashSimple as PhosphorTrashSimple,
  Tray as PhosphorTray,
  UploadSimple as PhosphorUploadSimple,
  User as PhosphorUser,
  Users as PhosphorUsers,
  WarningCircle as PhosphorWarningCircle,
  X as PhosphorX,
  type Icon as PhosphorIcon,
  type IconProps as PhosphorIconProps,
} from "@phosphor-icons/react";
import type { ReactNode, SVGProps } from "react";

export type HanjiIconProps = SVGProps<SVGSVGElement> & {
  size?: number;
  /**
   * Optical stroke weight for Phosphor-backed icons. Defaults to "light".
   * Ignored by hand-authored `IconSvg` glyphs (they have a fixed stroke).
   */
  weight?: PhosphorIconProps["weight"];
};

function PhosphorIconSvg({
  icon: Icon,
  size = 16,
  weight = "light",
  ...rest
}: HanjiIconProps & {
  icon: PhosphorIcon;
  weight?: PhosphorIconProps["weight"];
}) {
  const {
    "aria-hidden": ariaHidden,
    ...iconProps
  } = rest as Omit<PhosphorIconProps, "size" | "weight">;

  return (
    <Icon
      {...iconProps}
      size={size}
      weight={weight}
      aria-hidden={ariaHidden ?? "true"}
      data-hanji-icon="true"
      data-hanji-icon-source="phosphor"
      data-hanji-icon-weight={weight}
    />
  );
}

function IconSvg({
  size = 16,
  weight: _weight,
  children,
  ...rest
}: HanjiIconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
      aria-hidden="true"
      data-hanji-icon="true"
      data-hanji-icon-source="hanji"
      data-hanji-icon-weight="1.7"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const ChevronRight = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorCaretRight} />
);

export const CaretRightFill = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorCaretRight} weight="fill" />
);

export const PlayIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorPlay} />
);

export const PauseIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorPause} />
);

export const ChevronLeft = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorCaretLeft} />
);

export const ArrowLeft = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <path d="M9.2 5.2 4.4 10l4.8 4.8" />
    <path d="M5 10h10.6" />
  </IconSvg>
);

export const ArrowRight = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <path d="m10.8 5.2 4.8 4.8-4.8 4.8" />
    <path d="M4.4 10H15" />
  </IconSvg>
);

export const ArrowUp = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <path d="M5.2 9.2 10 4.4l4.8 4.8" />
    <path d="M10 5v10.6" />
  </IconSvg>
);

export const ArrowDown = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <path d="m5.2 10.8 4.8 4.8 4.8-4.8" />
    <path d="M10 4.4V15" />
  </IconSvg>
);

export const ChevronDown = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorCaretDown} />
);

export const ChevronUp = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorCaretUp} />
);

export const DoubleChevronLeft = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorCaretDoubleLeft} />
);

export const DoubleChevronRight = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorCaretDoubleRight} />
);

export const MenuIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorSidebarSimple} />
);

export const Plus = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorPlus2} />
);

export const CheckIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorCheck} />
);

export const X = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorX} />
);

export const DotsHorizontal = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorDotsThree} />
);

export const EyeIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorEye} weight="fill" />
);

export const EyeSlashIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorEyeSlash} weight="fill" />
);

export const Home = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorHouse} />
);

export const Settings = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorGearSix} />
);

export const Search = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorMagnifyingGlass} />
);

export const CommentIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorChatTeardropText} />
);

export const Bell = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorBell} />
);

export const MailIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorTray} />
);

export const Copy = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorCopySimple} />
);

export const Download = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorDownloadSimple} />
);

export const LogOutIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <path d="M8.4 4.6H5.7c-.9 0-1.6.7-1.6 1.6v7.6c0 .9.7 1.6 1.6 1.6h2.7" />
    <path d="M9.2 10h6.4" />
    <path d="m12.7 6.9 3.1 3.1-3.1 3.1" />
  </IconSvg>
);

export const SmileIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <circle cx="10" cy="10" r="6.2" />
    <path d="M7.4 8h.01" />
    <path d="M12.6 8h.01" />
    <path d="M7.5 11.6c1.1 1.3 3.9 1.3 5 0" />
  </IconSvg>
);

export const ImageIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <rect x="3.7" y="4" width="12.6" height="11.4" rx="1.8" />
    <circle cx="7.4" cy="7.5" r="1.2" />
    <path d="m5.5 13.2 3.2-3.1 2.2 2.1 1.4-1.4 2.2 2.4" />
  </IconSvg>
);

export const Pencil = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <path d="m4.6 14.7.8-3.2 7.4-7.4a1.7 1.7 0 0 1 2.4 2.4l-7.4 7.4Z" />
    <path d="m11.8 5.1 3.1 3.1" />
    <path d="M4.2 16.3h11.6" />
  </IconSvg>
);

export const LinkIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorLinkSimple} />
);

export const GlobeIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorGlobe} />
);

export const LibraryIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorBooks} />
);

export const FileText = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorFileText} />
);

export const LockIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorLockSimple} />
);

export const UnlockIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorLockSimpleOpen} />
);

export const SharePeopleIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorUsers} />
);

export const Upload = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorUploadSimple} />
);

export const MoveIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <path d="M4.2 10h11.6" />
    <path d="m11.5 5.8 4.3 4.2-4.3 4.2" />
    <path d="M4.2 5.2v9.6" />
  </IconSvg>
);

export const TurnIntoIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <path d="M4 5.5h6c2.4 0 4.4 2 4.4 4.4v1" />
    <path d="m11.5 8 2.9 2.9L17.3 8" />
    <path d="M4 14.5h5.2" />
  </IconSvg>
);

export const PaletteIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <path d="M10 3.6a6.3 6.3 0 0 0-2.2 12.2c.9.3 1.4-.2 1.4-.9 0-.6.5-1.1 1.1-1.1h1.3A4.9 4.9 0 0 0 10 3.6Z" />
    <path d="M7 7.7h.01" />
    <path d="M9.3 6.2h.01" />
    <path d="M12.1 7.4h.01" />
  </IconSvg>
);

export const OpenInNew = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorArrowSquareOut} />
);

export const OpenAsPage = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorArrowSquareOut} />
);

export const DragHandleIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorDotsSixVertical} />
);

export const Trash = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorTrashSimple} />
);

export const Star = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorStar} />
);

export const StarFilled = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorStar} weight="fill" />
);

export const ClockIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorClock} />
);

export const TextIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorTextT} />
);

export const HeadingOneIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorTextHOne} />
);

export const HeadingTwoIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorTextHTwo} />
);

export const HeadingThreeIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorTextHThree} />
);

export const BulletedListIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorListBullets} />
);

export const NumberedListIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorListNumbers} />
);

export const QuoteIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorQuotes} />
);

export const CodeIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorCode} />
);

export const DividerIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorMinus} />
);

export const EquationIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorMathOperations} />
);

export const ColumnsIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorColumns} />
);

export const CalloutIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorWarningCircle} />
);

export const AudioIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorSpeakerHigh} />
);

export const HashIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <path d="M8 4.1 7 15.9" />
    <path d="M13 4.1 12 15.9" />
    <path d="M4.8 7.4h11" />
    <path d="M4.2 12.6h11" />
  </IconSvg>
);

export const CheckboxIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <rect x="4.2" y="4.2" width="11.6" height="11.6" rx="1.8" />
    <path d="m7 10.2 2.2 2.1 4-4.5" />
  </IconSvg>
);

export const UserIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorUser} />
);

export const PhoneIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <path d="m6.7 4 1.6 3-1.2 1.2a9.5 9.5 0 0 0 4.6 4.6l1.2-1.2 3 1.7-1 2.4c-.2.6-.8 1-1.4.9A11.8 11.8 0 0 1 3.4 6.6c-.1-.7.3-1.3.9-1.6Z" />
  </IconSvg>
);

export const IdIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <rect x="3.7" y="5" width="12.6" height="10" rx="1.6" />
    <path d="M6.4 8h2.6" />
    <path d="M6.4 10.2h1.8" />
    <path d="M11 8.7h2.6" />
    <path d="M11 11.3h2.6" />
  </IconSvg>
);

export const FormulaIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <path d="M13.2 4.5H9.5c-.9 0-1.5.5-1.7 1.3l-2.5 9.7" />
    <path d="M5.8 9h5.1" />
    <path d="m11 12.2 3.5 3.3" />
    <path d="m14.5 12.2-3.5 3.3" />
  </IconSvg>
);

export const RollupIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <path d="M4.6 5h9.2" />
    <path d="M4.6 9.3h9.2" />
    <path d="M4.6 13.6H11" />
    <path d="m13 11.2 2.4 2.4L13 16" />
  </IconSvg>
);

export const Database = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorDatabase} />
);

export const ChartIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorChartBar} />
);

export const LayoutIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <rect x="3.8" y="4" width="12.4" height="11.6" rx="1.6" />
    <path d="M3.8 7.9h12.4" />
    <path d="M7.9 7.9v7.7" />
  </IconSvg>
);

export const PropertiesIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <path d="M4.8 5.4h10.4" />
    <path d="M4.8 10h10.4" />
    <path d="M4.8 14.6h10.4" />
    <circle cx="7.1" cy="5.4" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="12" cy="10" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="9.3" cy="14.6" r="1.15" fill="currentColor" stroke="none" />
  </IconSvg>
);

export const FilterIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <path d="M4.2 5h11.6l-4.4 5v3.9l-2.8 1.4V10Z" />
  </IconSvg>
);

export const SortIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <path d="M6.6 4.4v10.2" />
    <path d="m4.4 12.4 2.2 2.2 2.2-2.2" />
    <path d="M13.4 15.6V5.4" />
    <path d="m11.2 7.6 2.2-2.2 2.2 2.2" />
  </IconSvg>
);

export const SelectIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <rect x="3.8" y="6.3" width="12.4" height="7.4" rx="3.7" />
    <path d="M7.1 10h.01" />
    <path d="M9.8 10h3.1" />
  </IconSvg>
);

export const StatusIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <circle cx="10" cy="10" r="5.8" />
    <path d="M10 7v3.3l2.5 1.5" />
  </IconSvg>
);

export const TableIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <rect x="4" y="4" width="12" height="12" rx="1.5" />
    <path d="M4 8h12" />
    <path d="M4 12h12" />
    <path d="M8 4v12" />
    <path d="M12 4v12" />
  </IconSvg>
);

export const BoardIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <rect x="4" y="4" width="12" height="12" rx="1.5" />
    <path d="M8 4v12" />
    <path d="M12 4v12" />
    <path d="M5.6 6.6h1.1" />
    <path d="M9.6 9h1" />
    <path d="M13.5 7.4h1" />
  </IconSvg>
);

export const ListIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <path d="M7.2 5.7h8" />
    <path d="M7.2 10h8" />
    <path d="M7.2 14.3h8" />
    <circle cx="4.7" cy="5.7" r=".65" fill="currentColor" stroke="none" />
    <circle cx="4.7" cy="10" r=".65" fill="currentColor" stroke="none" />
    <circle cx="4.7" cy="14.3" r=".65" fill="currentColor" stroke="none" />
  </IconSvg>
);

export const CalendarIcon = (p: HanjiIconProps) => (
  <PhosphorIconSvg {...p} icon={PhosphorCalendarBlank} />
);

export const TimelineIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <path d="M4 5.5h12" />
    <path d="M4 10h12" />
    <path d="M4 14.5h12" />
    <rect x="5.2" y="4.2" width="4.2" height="2.6" rx=".7" />
    <rect x="10.4" y="8.7" width="4.4" height="2.6" rx=".7" />
    <rect x="6.5" y="13.2" width="4.6" height="2.6" rx=".7" />
  </IconSvg>
);

export const GalleryIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <rect x="4" y="4" width="4.6" height="4.6" rx="1" />
    <rect x="11.4" y="4" width="4.6" height="4.6" rx="1" />
    <rect x="4" y="11.4" width="4.6" height="4.6" rx="1" />
    <rect x="11.4" y="11.4" width="4.6" height="4.6" rx="1" />
  </IconSvg>
);

export const VideoIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <rect x="3.8" y="5" width="12.4" height="10" rx="1.7" />
    <path d="m8.4 8 3.7 2-3.7 2Z" />
  </IconSvg>
);

export const BookmarkIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <path d="M5.3 4.2c0-.8.6-1.4 1.4-1.4h6.6c.8 0 1.4.6 1.4 1.4v12.6L10 13.7l-4.7 3.1Z" />
  </IconSvg>
);

export const AlignLeftIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <path d="M4 5h12" />
    <path d="M4 10h8" />
    <path d="M4 15h12" />
  </IconSvg>
);

export const AlignCenterIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <path d="M4 5h12" />
    <path d="M6 10h8" />
    <path d="M4 15h12" />
  </IconSvg>
);

export const AlignRightIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <path d="M4 5h12" />
    <path d="M8 10h8" />
    <path d="M4 15h12" />
  </IconSvg>
);

export const SyncIcon = (p: HanjiIconProps) => (
  <IconSvg {...p}>
    <path d="M15 6.4A5.6 5.6 0 0 0 5.5 5.8L4 7.3" />
    <path d="M4 4v3.3h3.3" />
    <path d="M5 13.6a5.6 5.6 0 0 0 9.5.6L16 12.7" />
    <path d="M16 16v-3.3h-3.3" />
  </IconSvg>
);
