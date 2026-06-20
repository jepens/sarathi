# Mobile UX Audit — Sarathi Dashboard

> Audited at ~390–430px (iPhone 14 Pro Max is 430px). Stack: Next 16 (App Router, react-compiler), React 19, Tailwind v4, shadcn-style Radix UI (`components/ui/`), lucide-react, framer-motion. styled-jsx is banned here (Turbopack + react-compiler hydration bug) — use `globals.css` / Tailwind arbitrary values.

## How to read this

- **Severity:** `critical` = unusable / broken on a phone · `high` = significant friction · `medium` = noticeable · `low` = polish.
- Every row gives an exact `file:line` and a concrete Tailwind fix.
- **The shell fix (Section 0) is the single highest-impact change.** It was flagged as `critical` by almost every page (the 256px sidebar + `p-8` crushes content on every screen). It is listed **once** here; assume it applies globally and is **not** repeated per page below.

## The core diagnosis (one paragraph)

Most *page content* is already responsive (Overview, Settings, Vendors, Products stack via `md:grid-cols-*`). The mobile experience breaks because **the app shell never switches to a mobile layout**: the sidebar is hard-coded `w-64` (256px) with no hamburger/drawer, and `<main>` uses a fixed `p-8`. On a 430px phone that leaves ~110–170px of usable width, into which desktop-only components (two-pane inbox, multi-column tables, a 7-column kanban) are then crushed. Fix the shell first; then address the genuinely desktop-only components (Tier 2 below).

---

## 0. Shell — GLOBAL ROOT CAUSE (fix first)

Files: [app/dashboard/layout.tsx](app/dashboard/layout.tsx), [components/sidebar.tsx](components/sidebar.tsx)

| Sev | Location | Problem | Fix |
|---|---|---|---|
| 🔴 critical | components/sidebar.tsx:24 | Sidebar is always `w-64` (256px), no responsive behavior, no hamburger/drawer — consumes ~60% of a phone viewport. | Render an off-canvas drawer on mobile + static rail on desktop. Adopt the shadcn `Sidebar` primitive (see Appendix A), or minimally: `hidden md:flex` on this div + a Sheet drawer triggered by a hamburger. |
| 🔴 critical | app/dashboard/layout.tsx:10 | Root layout is `flex` (row) unconditionally → sidebar + main are forced side-by-side on phones. | `flex flex-col md:flex-row min-h-dvh bg-background` (stack on mobile) — or use the Sidebar primitive's `SidebarProvider`/`SidebarInset`. |
| 🟠 high | app/dashboard/layout.tsx:13 | `<main className="flex-1 p-8">` — 32px padding each side on a phone. | `flex-1 p-4 md:p-8 overflow-y-auto pb-[max(1rem,env(safe-area-inset-bottom))]` |
| 🟠 high | components/sidebar.tsx:24 | `min-h-screen` + no responsive prefix keeps the rail full-height even when it should be a drawer. | Add `hidden md:flex`; swap `min-h-screen` → `md:min-h-dvh`. |
| 🟡 medium | app/dashboard/layout.tsx:10 | `min-h-screen` (100vh) ignores mobile browser chrome. | `min-h-dvh`. |

Also add `viewport-fit=cover` to the viewport meta in `app/layout.tsx` so `env(safe-area-inset-*)` is honored once the shell goes edge-to-edge.

---

## 1. Overview — `poor`

File: [app/dashboard/page.tsx](app/dashboard/page.tsx). *Best-behaved page — grids already stack; issues are sizing/density.*

| Sev | Location | Problem | Fix |
|---|---|---|---|
| 🔴 critical | app/dashboard/page.tsx:94 | `text-3xl` heading dominates a narrow viewport and wraps badly. | `text-lg sm:text-2xl lg:text-3xl` |
| 🟠 high | app/dashboard/page.tsx:104 | KPI grid gap is fixed; cards feel sparse/tall on mobile. | `grid grid-cols-1 gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4` |
| 🟠 high | app/dashboard/page.tsx:162 | Funnel/Upcoming grid gap fixed. | `grid gap-3 sm:gap-4 lg:grid-cols-2` |
| 🟠 high | app/dashboard/page.tsx:304 | KPI value `text-2xl` overflows for `Rp 12.345.678` in a narrow card. | `text-base sm:text-xl lg:text-2xl` |
| 🟡 medium | app/dashboard/page.tsx:254 | Upcoming-events row (`flex justify-between`) competes for width; wraps awkwardly. | `flex flex-col sm:flex-row items-start sm:items-center justify-between text-xs sm:text-sm gap-2 sm:gap-0` |
| 🟡 medium | app/dashboard/OnboardingChecklist.tsx:156 | Fixed `w-24` label in CopyRow is rigid on a phone. | `w-16 sm:w-24` (or `min-w-min`) |
| 🟡 medium | app/dashboard/page.tsx:92 | `space-y-6` between sections is heavy on mobile. | `space-y-3 sm:space-y-5 lg:space-y-6` |

---

## 2. Knowledge Base — `fair`

File: [app/dashboard/knowledge/page.tsx](app/dashboard/knowledge/page.tsx)

| Sev | Location | Problem | Fix |
|---|---|---|---|
| 🔴 critical | app/dashboard/knowledge/page.tsx:60-72 | Header `flex justify-between` squeezes title + "Tulis / Edit Konten" button on one row. | `flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4` (full-width button on mobile) |
| 🟠 high | components/dashboard/DocumentList.tsx:78 | Empty state `p-8` wastes space. | `p-4 sm:p-8` |
| 🟠 high | components/dashboard/DocumentList.tsx:91-102 | Filename has no truncation → overflow on long names. | add `truncate` to the filename `<p>` |
| 🟡 medium | components/ui/card.tsx:23,68 | `px-6` card padding is heavy on a constrained width (affects **all** cards app-wide). | `px-4 sm:px-6` on CardHeader/CardContent |
| 🟡 medium | app/dashboard/knowledge/page.tsx:62 | `text-3xl` heading too large on mobile. | `text-2xl sm:text-3xl` |

---

## 3. Knowledge Editor — `broken`

File: [app/dashboard/knowledge/editor/page.tsx](app/dashboard/knowledge/editor/page.tsx)

| Sev | Location | Problem | Fix |
|---|---|---|---|
| 🔴 critical | app/dashboard/knowledge/editor/page.tsx:151 | `lg:grid-cols-[1fr_300px]` — the 300px "Dokumen tersimpan" card becomes full-width with no height cap on mobile, dominating the viewport. | `grid grid-cols-1 lg:grid-cols-[1fr_300px]` + `max-h-52 overflow-y-auto` on the card on mobile |
| 🔴 critical | app/dashboard/knowledge/editor/page.tsx:158 | `SelectTrigger` hard-coded `w-[260px]` → overflow. | `w-full sm:w-[260px]` |
| 🟠 high | app/dashboard/knowledge/editor/page.tsx:144 | `text-3xl` heading oversized. | `text-2xl sm:text-3xl` |
| 🟠 high | app/dashboard/knowledge/editor/page.tsx:154 | Toolbar `flex flex-wrap items-end` (Select + Button) overflows. | `flex flex-col sm:flex-row sm:flex-wrap items-start sm:items-end gap-3` |
| 🟠 high | app/dashboard/knowledge/editor/page.tsx:195 | Textarea `min-h-[460px]` forces excessive scroll on a phone. | `min-h-[200px] sm:min-h-[320px] md:min-h-[460px]` |
| 🟡 medium | app/dashboard/knowledge/editor/page.tsx:135-149 | `space-y-6` header eats vertical space. | `space-y-3 sm:space-y-6` |
| 🟡 medium | app/dashboard/knowledge/editor/page.tsx:227 | Source-list touch targets/text too small (`h-3.5`, `text-xs`). | `h-4 w-4 sm:h-3.5 sm:w-3.5`, `text-sm sm:text-xs` |

---

## 4. Paket Acara (Products) — `broken`

File: [app/dashboard/products/page.tsx](app/dashboard/products/page.tsx)

| Sev | Location | Problem | Fix |
|---|---|---|---|
| 🟠 high | app/dashboard/products/page.tsx:67-78 | Header `flex justify-between` cramps heading + button. | `flex flex-col gap-4 md:flex-row md:items-center md:justify-between` |
| 🟠 high | app/dashboard/products/page.tsx:106 | Search `max-w-sm` overflows narrow content area. | `w-full md:max-w-sm` |
| 🟠 high | components/dashboard/ProductList.tsx:88-149 | Item row `flex items-center justify-between` (icon+text+badge + 2 buttons) can't fit. | `flex flex-col gap-3 md:flex-row md:items-center md:justify-between` |
| 🟠 high | components/dashboard/ProductList.tsx:124-146 | Edit/Delete buttons `size-sm` (~32px) below the 44px touch minimum. | enlarge on mobile: `h-10 w-10 sm:h-8 sm:w-8` |
| 🟡 medium | components/dashboard/ProductList.tsx:103 | Badge `text-[10px]` below readable minimum. | `text-xs` |
| 🟡 medium | components/dashboard/ProductDialog.tsx:87 | `sm:max-w-[425px]` needs >425px; cramped on a phone. | `max-w-[calc(100vw-2rem)] sm:max-w-[425px]` |
| 🟡 medium | app/dashboard/products/page.tsx:66 | `space-y-8` heavy on mobile. | `space-y-4 md:space-y-8` |
| ⚪ low | components/dashboard/IntegrationInfoBanner.tsx:23 | `p-4` two-col banner may wrap awkwardly. | add `flex-col sm:flex-row` as a safeguard |

---

## 5. Bookings (Orders) — `poor`

File: [app/dashboard/orders/page.tsx](app/dashboard/orders/page.tsx)

| Sev | Location | Problem | Fix |
|---|---|---|---|
| 🔴 critical | app/dashboard/orders/components/OrderList.tsx:164-257 | 8-column table (Tanggal, Pelanggan, Tipe, Items, Total, Info Pengiriman, Status, Aksi) doesn't stack/hide → forced horizontal scroll. | Hide non-critical columns with `hidden sm:table-cell` (Tipe, Items, Info Pengiriman) **and** add a mobile card view (see Appendix D: Table→cards). |
| 🟠 high | app/dashboard/orders/components/OrderList.tsx:217 | Delivery cell `max-w-[200px]` exceeds available width. | `max-w-[120px] sm:max-w-[200px]` or `hidden sm:table-cell` |
| 🟠 high | app/dashboard/orders/components/OrderList.tsx:201-212 | Items `<li>` list wraps and eats vertical space. | Show item **count** on mobile; full list `hidden sm:table-cell` |
| 🟡 medium | app/dashboard/orders/components/OrderList.tsx:192-195 | Customer name + phone stack awkwardly. | `text-xs sm:text-sm`; hide phone `hidden sm:inline` |
| 🟡 medium | app/dashboard/orders/components/OrderList.tsx:188-190 | Full datetime wraps. | `whitespace-nowrap`, or short `1 Jan` on mobile with time `hidden sm:inline` |
| 🟡 medium | app/dashboard/orders/components/OrderList.tsx:228 | Action button `h-8 w-8` (~32px) below touch minimum. | `h-9 w-9 sm:h-8 sm:w-8` |
| ⚪ low | app/dashboard/orders/page.tsx:7-10 | Header/description slightly small. | `text-base sm:text-lg` / `text-xs sm:text-sm` |

*Positive: the table is already wrapped in `overflow-x-auto`, so it scrolls rather than breaking the page.*

---

## 6. Pipeline (Kanban) — `broken`

File: [app/dashboard/pipeline/page.tsx](app/dashboard/pipeline/page.tsx)

| Sev | Location | Problem | Fix |
|---|---|---|---|
| 🔴 critical | app/dashboard/pipeline/components/PipelineBoard.tsx:234 | 7 columns × `w-72` (288px) → severe horizontal overflow; drag/drop unusable on a phone. | Mobile: one column at a time. `w-[85vw] sm:w-72` so a column nearly fills the screen and swipes, **or** `flex flex-col sm:flex-row` to stack with a stage picker. |
| 🔴 critical | app/dashboard/pipeline/page.tsx:9 | `h-[calc(100vh-4rem)]` includes mobile browser chrome. | `h-[calc(100dvh-4rem)]` |
| 🟠 high | app/dashboard/pipeline/components/SendProposalDialog.tsx:248 | Dialog lacks mobile max-width. | `max-w-[calc(100vw-2rem)] sm:max-w-lg` |
| 🟠 high | app/dashboard/pipeline/components/SendProposalDialog.tsx:294 | FNA form `grid grid-cols-2` cramps fields. | `grid grid-cols-1 sm:grid-cols-2 gap-2` |
| 🟠 high | app/dashboard/pipeline/components/ProposalHistoryDialog.tsx:106 | Dialog lacks mobile max-width. | `max-w-[calc(100vw-2rem)] sm:max-w-lg` |
| 🟠 high | app/dashboard/pipeline/components/ProposalHistoryDialog.tsx:182 | FNA snapshot `grid-cols-2` cramped. | `grid grid-cols-1 sm:grid-cols-2` |
| 🟡 medium | app/dashboard/pipeline/components/PipelineBoard.tsx:222 | No iOS momentum scroll / no scroll affordance. | `[-webkit-overflow-scrolling:touch]` + a swipe hint |
| 🟡 medium | app/dashboard/pipeline/components/PipelineBoard.tsx:336-343 | Card dropdown trigger `h-6 w-6` hard to tap near edge. | `h-8 w-8 sm:h-6 sm:w-6`; card padding `p-2 sm:p-3` |

---

## 7. Calendar — `broken`

File: [app/dashboard/calendar/page.tsx](app/dashboard/calendar/page.tsx)

| Sev | Location | Problem | Fix |
|---|---|---|---|
| 🔴 critical | app/dashboard/calendar/components/EventsCalendar.tsx:148 | Fixed `h-[700px]` overflows/clips on a phone. | `h-[480px] sm:h-[600px] md:h-[700px]` or `max-h-[calc(100dvh-200px)]` |
| 🟠 high | app/dashboard/calendar/components/EventsCalendar.tsx:141 | Legend `flex gap-4` wraps/overflows. | `flex flex-wrap gap-2` (or `sm:flex-col`) |
| 🟠 high | app/dashboard/calendar/components/EventsCalendar.tsx:141-147 | Legend `text-xs` too small. | `text-xs sm:text-sm` |
| 🟡 medium | app/dashboard/calendar/page.tsx:7 | `text-2xl` heading large for the space. | `text-xl sm:text-2xl` |
| 🟡 medium | app/dashboard/calendar/components/EventsCalendar.tsx:140 | Schedule X may generate its own internal horizontal overflow on narrow screens. | Verify Schedule X mobile config; wrap in `overflow-x-auto` if needed. |

---

## 8. AI Chat — `poor`

File: [app/dashboard/chat/page.tsx](app/dashboard/chat/page.tsx)

| Sev | Location | Problem | Fix |
|---|---|---|---|
| 🔴 critical | app/dashboard/chat/page.tsx:140 | `h-[calc(100vh-4rem)]` ignores mobile chrome. | `h-[calc(100dvh-4rem)]` |
| 🔴 critical | app/dashboard/chat/page.tsx:143,152,204 | `px-6` (48px total) crushes message width. | `px-3 sm:px-4 md:px-6` |
| 🟠 high | app/dashboard/chat/page.tsx:144 | `text-2xl` heading wraps. | `text-lg sm:text-xl md:text-2xl` |
| 🟠 high | app/dashboard/chat/page.tsx:218 | Send button fixed `h-[60px] w-[60px]` adds layout pressure. | `size-10 sm:size-12 md:size-[60px]` |
| 🟡 medium | app/dashboard/chat/page.tsx:211 | Textarea `min-h-[60px]` adds vertical pressure. | `min-h-12 sm:min-h-[50px] md:min-h-[60px]` |
| 🟡 medium | app/dashboard/chat/page.tsx:174 | Bubble `max-w-[80%]` wraps too tightly on mobile. | `max-w-[85%] sm:max-w-[75%] md:max-w-[80%]` |

---

## 9. WhatsApp Inbox — `broken` ⭐ (the screenshot screen)

Files: [app/dashboard/chats/page.tsx](app/dashboard/chats/page.tsx), [ChatList.tsx](app/dashboard/chats/components/ChatList.tsx), [ChatWindow.tsx](app/dashboard/chats/components/ChatWindow.tsx), [SendTemplateDialog.tsx](app/dashboard/chats/components/SendTemplateDialog.tsx)

| Sev | Location | Problem | Fix |
|---|---|---|---|
| 🔴 critical | app/dashboard/chats/page.tsx:17-34 | Two-pane `w-1/3` list + `flex-1` window **never collapses** → both panes illegible on a phone. | Master-detail (Appendix C): list-only on mobile, slide to conversation with a Back button, two-pane on `md:`. Drive selection via the existing `?phone=` searchParam so Back/deep-links work. |
| 🔴 critical | app/dashboard/chats/page.tsx:17 | `h-[calc(100vh-8rem)]` → composer hides under iOS keyboard/home bar. | `h-[calc(100dvh-8rem)]` |
| 🟠 high | ChatWindow.tsx:338, ChatList.tsx:108 | Hard-coded hex (`#efeae2`, `#f0f2f5`, `#111b21`, `#667781`, `#8696a0`) **ignore dark mode** → dark text on dark bg. | Add `dark:` variants or switch to semantic tokens (`bg-background`, `text-foreground`, `bg-muted`). |
| 🟠 high | SendTemplateDialog.tsx:194 | `sm:max-w-[560px]` with no mobile width. | `max-w-[90vw] sm:max-w-[560px]` (or a bottom Sheet on mobile — Appendix B). |
| 🟠 high | ChatWindow.tsx:85-90 | `MessagesSkeleton` hard-coded widths (`w-48`…`w-56`) overflow. | responsive widths or `max-w-[70%]` |
| 🟠 high | ChatWindow.tsx:403 | Message area `p-4` leaves little width on a narrow pane. | `px-2 sm:px-4` |
| 🟡 medium | ChatList.tsx:168,180 | `text-[12px]` / `text-[10px]` too small. | bump to `text-xs`+ |
| 🟡 medium | ChatWindow.tsx:493,512 | Send/template buttons `h-12 w-12` consume ~¼ of a narrow input bar. | `h-10 w-10 sm:h-12 sm:w-12` |
| 🟡 medium | ChatList.tsx:109 | Search container `p-3`. | `p-2 sm:p-3` |
| 🟡 medium | ChatWindow.tsx:339 | Header `gap-3`; name + badge wrap. | `gap-2 sm:gap-3`, wrap name/badge `flex-col sm:flex-row` |

---

## 10. Contacts — `broken`

File: [app/dashboard/contacts/page.tsx](app/dashboard/contacts/page.tsx)

| Sev | Location | Problem | Fix |
|---|---|---|---|
| 🔴 critical | app/dashboard/contacts/components/ContactList.tsx:412 | Search input hard-coded `w-64` (256px) → overflow. | `relative flex-1 min-w-0` |
| 🔴 critical | app/dashboard/contacts/components/ContactList.tsx:404-421 | Header (Tabs + search) side-by-side with no breakpoints. | `flex flex-col md:flex-row md:items-center md:justify-between gap-3` |
| 🔴 critical | app/dashboard/contacts/components/ContactList.tsx:448-512 | 6-column table + `px-6 py-4` → massive horizontal overflow. | Mobile card layout (`hidden md:table` on table + card list) and/or reduce padding `px-2 md:px-6 py-2 md:py-4`. |
| 🟠 high | app/dashboard/contacts/components/ContactList.tsx:518 | Detail dialog `max-w-lg`, no mobile buffer. | `max-w-sm md:max-w-lg` |
| 🟠 high | app/dashboard/contacts/components/ContactList.tsx:617,644 | Promote-to-vendor dialog: no max-width + `grid-cols-2` inputs side-by-side. | add `max-w-sm md:max-w-lg`; `grid grid-cols-1 md:grid-cols-2 gap-3` |
| 🟠 high | app/dashboard/contacts/page.tsx:12 | `h-[calc(100vh-12rem)]` ignores mobile chrome. | `h-[calc(100dvh-12rem)]` |
| 🟡 medium | app/dashboard/contacts/components/ContactList.tsx:427-430 | Table headers don't hide on mobile. | `hidden md:table-cell` on Acara/Tawaran, Peserta, Last Active |
| 🟡 medium | app/dashboard/contacts/components/ContactList.tsx:552-580 | Detail `Field` `w-24` labels cramp. | `flex flex-col gap-1 md:flex-row md:items-center`, `md:w-24` |
| 🟡 medium | app/dashboard/contacts/components/ContactList.tsx:678-681 | Edit dialog `grid grid-cols-4` (label+input) cramped. | `grid grid-cols-1 md:grid-cols-4` |

---

## 11. Vendors — `broken`

File: [app/dashboard/vendors/page.tsx](app/dashboard/vendors/page.tsx)

| Sev | Location | Problem | Fix |
|---|---|---|---|
| 🔴 critical | app/dashboard/vendors/page.tsx:85 | `h1 text-3xl` aggressive wrap on mobile. | `text-xl sm:text-2xl md:text-3xl` |
| 🟠 high | app/dashboard/vendors/page.tsx:138 | Search wrapper `min-w-[240px]` forces overflow. | `w-full md:max-w-md` (drop `min-w-[240px]`) |
| 🟠 high | app/dashboard/vendors/page.tsx:151 | `SelectTrigger w-[200px]` fixed. | `w-full md:w-[200px]` |
| 🟠 high | components/dashboard/VendorDialog.tsx:159 | Form `grid grid-cols-2` cramps inputs. | `grid grid-cols-1 md:grid-cols-2 gap-4` |
| 🟡 medium | app/dashboard/vendors/page.tsx:96 | Stat-card numbers `text-2xl` not scaled. | `text-lg sm:text-2xl` |
| 🟡 medium | app/dashboard/vendors/page.tsx:118 | Category badge group may overflow. | `overflow-x-auto` or smaller badges `text-[10px] sm:text-xs` |
| 🟡 medium | components/dashboard/VendorList.tsx:175 | 4-button action row (verify/chat/edit/delete) cramped. | reduce gap `gap-0.5 md:gap-1`, wrap, or hide non-critical on mobile |
| ⚪ low | components/dashboard/VendorList.tsx:121 | Category badge `text-[10px]`. | `text-[9px] sm:text-[10px]` or `text-xs` |

*Positive: vendor cards already use `md:grid-cols-2` and the Dialog uses `calc(100%-2rem)`.*

---

## 12. Settings — `fair`

File: [app/dashboard/settings/page.tsx](app/dashboard/settings/page.tsx)

| Sev | Location | Problem | Fix |
|---|---|---|---|
| 🟠 high | app/dashboard/settings/components/SystemMessageEditor.tsx:288 | Textarea `min-h-[400px]` dominates mobile. | `min-h-[200px] sm:min-h-[300px] md:min-h-[400px]` |
| 🟠 high | app/dashboard/settings/components/TestChatPreview.tsx:123 | ScrollArea fixed `h-[400px]` eats the viewport. | `h-[300px] sm:h-[400px]` |
| 🟠 high | app/dashboard/settings/components/SettingsTabs.tsx:17 | `grid-cols-5` → 5 tiny tabs (<44px tap). | `grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5` |
| 🟡 medium | app/dashboard/settings/page.tsx:44 | `text-3xl` heading. | `text-2xl sm:text-3xl` |
| 🟡 medium | app/dashboard/settings/components/KnowledgeCoverageSummary.tsx:100 | `grid-cols-2` cramped on mobile. | `grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-4` |
| 🟡 medium | app/dashboard/settings/components/TestChatPreview.tsx:138 | Bubble `max-w-[80%]`. | `max-w-[90%] sm:max-w-[80%]`, `p-2 sm:p-3` |
| ⚪ low | app/dashboard/settings/components/WebhookSettings.tsx:81 | Long webhook URLs `font-mono text-sm` overflow. | `font-mono text-xs sm:text-sm` |

*Positive: tab labels already collapse to icons on mobile (`hidden sm:inline`); forms use `sm:grid-cols-2`.*

---

## 13. Shared components (fix once, helps everywhere)

| Location | Problem | Fix |
|---|---|---|
| components/ui/card.tsx:23,68 | `px-6` padding on every CardHeader/CardContent is heavy on phones. | `px-4 sm:px-6` |
| components/ui/button.tsx | Default `h-9` (36px) and icon sizes are below the 44px iOS touch target. | Consider a mobile-bumped size, or enlarge per-use on touch-critical buttons. |
| components/ui/dialog.tsx | Already uses `calc(100%-2rem)` (good) — but per-dialog `sm:max-w-*` still needs a mobile fallback, or convert to a bottom Sheet/Drawer (Appendix B). |

---

# Appendix — recommended patterns (from Context7)

> Sources pulled via Context7: `shadcn/ui` (sidebar, sheet, responsive dialog, table→card), `tailwindlabs/tailwindcss.com` (dvh, container queries, safe-area).

## A. Responsive Sidebar (the shell fix)

The shadcn `Sidebar` primitive renders a **Sheet (drawer) on mobile** and a **static collapsible rail on desktop**, switched internally by a `useIsMobile()` hook. Your repo is mostly ready: `globals.css` **already defines all `--sidebar-*` color tokens + `@theme inline` mappings**, and `@radix-ui/react-dialog` (Sheet) + `@radix-ui/react-slot` (asChild) are already installed.

```
npx shadcn@latest add sidebar   # adds ui/sidebar.tsx, ui/sheet.tsx, ui/tooltip.tsx, ui/separator.tsx, hooks/use-mobile.ts
```
Then convert `components/sidebar.tsx` → `components/app-sidebar.tsx` (each `<Link><Button variant={pathname===x?'secondary':'ghost'}>` becomes `<SidebarMenuButton asChild isActive={pathname===x}>`; for `chats`/`contacts`/`vendors` use `isActive={pathname.startsWith(x)}`), and rewrite `app/dashboard/layout.tsx`:

```tsx
<SidebarProvider>
  <NavProgress />
  <AppSidebar />
  <SidebarInset>
    <header className="flex h-14 items-center gap-2 border-b px-4 sticky top-0 bg-background z-10">
      <SidebarTrigger />   {/* hamburger: opens the Sheet on mobile, collapses the rail on desktop */}
    </header>
    <main className="flex-1 p-4 md:p-8 overflow-y-auto">{children}</main>
  </SidebarInset>
</SidebarProvider>
```
(Manual deps if not using the CLI: `@radix-ui/react-tooltip`, `@radix-ui/react-separator`.)

## B. Dialog → bottom Sheet/Drawer on mobile

Two options: **Sheet** `side="bottom"` (no new dep — just Radix Dialog) for a quick bottom-sheet, or `npm install vaul` + a `ResponsiveDialog` wrapper that renders a `Dialog` on desktop and a draggable `Drawer` on mobile, switched by an SSR-safe `useMediaQuery('(min-width:768px)')`. Keep `MOBILE_BREAKPOINT = 768` aligned with Tailwind's `md`.

## C. Inbox master-detail (CSS-only, route-driven — hydration-safe)

Drive selection with the existing `?phone=` searchParam. Single column on mobile, 2-col grid on `md:`. List hides once a chat is open; a `<ChevronLeft/> Back` link (`md:hidden`) clears the param.

```tsx
<div className="flex h-dvh flex-col md:grid md:grid-cols-[clamp(280px,32%,380px)_1fr]">
  <aside className={cn("min-w-0 overflow-y-auto border-r", hasSelection ? "hidden md:block" : "block")}>…list…</aside>
  <section className={cn("min-w-0 flex flex-col", hasSelection ? "block" : "hidden md:block")}>
    <header className="md:hidden"><Link href="/dashboard/chats"><ChevronLeft className="size-4"/> Back</Link></header>
    …conversation…
  </section>
</div>
```

## D. Table → stacked cards on mobile (one source array, two renders)

```tsx
<div className="hidden md:block"><Table>…</Table></div>
<div className="grid gap-3 md:hidden">
  {rows.map(r => <Card key={r.id} className="p-4">
    <div className="flex justify-between"><span className="font-semibold">{r.code}</span><span>{r.status}</span></div>
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className="text-muted-foreground">Customer</dt><dd>{r.customer}</dd>
      <dt className="text-muted-foreground">Total</dt><dd>{r.total}</dd>
    </dl>
  </Card>)}
</div>
```

## E. Global utilities

- **Viewport units:** replace `min-h-screen` → `min-h-dvh`, and every `h-[calc(100vh-…)]` → `h-[calc(100dvh-…)]`.
- **Safe area:** add `viewport-fit=cover` to the viewport meta; pad with `pb-[max(1rem,env(safe-area-inset-bottom))]`. Optionally register a v4 utility in `globals.css`: `@utility pb-safe { padding-bottom: max(0.5rem, env(safe-area-inset-bottom)); }`.
- **Container queries** (`@container`, no plugin in v4): ideal for Overview cards so they reflow by their own width, not the viewport.
- **Mobile-first rule:** unprefixed = mobile; `sm:`/`md:`/`lg:` mean "this width and up". Never hide mobile styles behind `sm:`.
