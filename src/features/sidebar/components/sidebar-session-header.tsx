// The list's header: the package's session search (`SessionSidebarSearch`),
// with Atlas's filter for which projects the list shows after it
// (`session-scope-filter.tsx`). A new session starts from the session's own
// crumb in the title bar (`session-switcher.tsx`), or its shortcut.

import { SessionSidebarSearch, type SessionSidebarSearchProps } from "@tryatlas/design";
import { SessionScopeFilter } from "./session-scope-filter";

export function SidebarSessionHeader(props: Omit<SessionSidebarSearchProps, "filter">) {
  return <SessionSidebarSearch {...props} filter={<SessionScopeFilter />} />;
}
