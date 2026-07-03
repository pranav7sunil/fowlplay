/** Inline SVG icon set — all currentColor, no external deps. */
import type { JSX } from 'preact';

type P = { size?: number } & JSX.SVGAttributes<SVGSVGElement>;

function svg(path: JSX.Element, { size = 18, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      {...rest}
    >
      {path}
    </svg>
  );
}

export const IconHistory = (p: P) => svg(<><path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /><path d="M12 7v5l4 2" /></>, p);
export const IconPlus = (p: P) => svg(<><path d="M12 5v14M5 12h14" /></>, p);
export const IconGear = (p: P) => svg(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>, p);
export const IconChevronRight = (p: P) => svg(<path d="M9 18l6-6-6-6" />, p);
export const IconChevronLeft = (p: P) => svg(<path d="M15 18l-6-6 6-6" />, p);
export const IconChevronDown = (p: P) => svg(<path d="M6 9l6 6 6-6" />, p);
export const IconArrowRight = (p: P) => svg(<><path d="M5 12h14M12 5l7 7-7 7" /></>, p);
export const IconArrowUp = (p: P) => svg(<><path d="M12 19V5M5 12l7-7 7 7" /></>, p);
export const IconStop = (p: P) => svg(<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />, p);
export const IconPencil = (p: P) => svg(<><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></>, p);
export const IconRerun = (p: P) => svg(<><path d="M23 4v6h-6" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></>, p);
export const IconRewind = (p: P) => svg(<><polygon points="11 19 2 12 11 5 11 19" fill="currentColor" stroke="none" /><polygon points="22 19 13 12 22 5 22 19" fill="currentColor" stroke="none" /></>, p);
export const IconCheck = (p: P) => svg(<path d="M20 6L9 17l-5-5" />, p);
export const IconX = (p: P) => svg(<path d="M18 6L6 18M6 6l12 12" />, p);
export const IconPaperclip = (p: P) => svg(<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />, p);
export const IconSearch = (p: P) => svg(<><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></>, p);
export const IconTrash = (p: P) => svg(<><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>, p);
export const IconCopy = (p: P) => svg(<><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>, p);
export const IconFile = (p: P) => svg(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>, p);
export const IconDiff = (p: P) => svg(<><path d="M12 3v18M5 8l-3 3 3 3M19 8l3 3-3 3" /></>, p);
export const IconGit = (p: P) => svg(<><circle cx="12" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="12" r="2" /><path d="M12 7v6a4 4 0 0 0 4 4M6 17V7" /></>, p);
export const IconWrench = (p: P) => svg(<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />, p);
export const IconShield = (p: P) => svg(<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></>, p);
export const IconEye = (p: P) => svg(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></>, p);
export const IconCompass = (p: P) => svg(<><circle cx="12" cy="12" r="10" /><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" fill="currentColor" stroke="none" /></>, p);
export const IconHammer = (p: P) => svg(<><path d="M14 6l6 6M4 20l7-7M11 5l3 3-8 8-3-3z" /></>, p);
export const IconAlert = (p: P) => svg(<><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></>, p);
export const IconRooster = (p: P) => svg(<path d="M9 4c1.5 0 2.5 1 2.5 2.5C13 5 15 4.5 16.5 5.5c1.3.9 1.3 2.6.3 3.6 1.7.4 2.7 1.6 2.7 3.4 0 3-2.5 5-5.5 5H12c-3 0-5.5-2-5.5-5 0-2 1-3.4 2.5-4-.8-.6-1-1.5-1-2.5C8 5 8.4 4 9 4z" fill="currentColor" stroke="none" />, p);
