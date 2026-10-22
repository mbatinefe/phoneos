# Settings (com.apple.Preferences)

What the app looks like to an agent, and what to watch out for.

## How you see it
Settings reads well: every row is an element, and most carry a stable id
(`#com.apple.settings.battery`, `#SW_VERSION_SPECIFIER`) that `find` and `tap text=` match.

## Layout (iOS 26)
- The **search field is at the bottom**, in the toolbar ("Search"). Results are buttons
  labelled "Title, where it is" ("Battery Percentage, Battery"), but the results screen
  takes about 15 seconds to read. To reach a page, `settings_open page="General > About"`
  walks the rows instead, a few seconds a page.
- The first page: your Apple Account, Airplane Mode (a switch), Wi-Fi, Bluetooth, Cellular,
  Battery, VPN, then General, Display & Brightness and the rest further down.
- Every page has a back button at the top left, labelled with the page before it (`#BackButton`).
- Switches report `value="1"` (on) or `value="0"` (off): read the value before and after a tap.
- Auto-Lock lives under Display & Brightness; the `set_auto_lock` tool sets it directly.

## Gotchas
- Airplane Mode, Wi-Fi, Bluetooth and VPN change how the phone reaches the network. Do
  not switch them unless the user asked.
- General → About also lists the serial number, IMEI, EID and network addresses. They
  identify the phone: never copy them into a reply or a report. `settings_about` leaves
  them out.
- Some rows are greyed out (`disabled` in observe), such as Personal Hotspot without a plan.

## Macros
`settings_open {page}` (a path such as "General > About") · `settings_about`. Pass
`device` to each one when more than one phone is registered.
