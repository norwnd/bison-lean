package locales

import "decred.org/dcrdex/client/intl"

var DeDE = map[string]*intl.Translation{
	"Language":                       {T: "de-DE"},
	"Markets":                        {T: "Märkte"},
	"Wallets":                        {T: "Wallets"},
	"Notifications":                  {T: "Benachrichtigungen"},
	"Recent Activity":                {T: "Letzte Aktivitäten"},
	"Sign Out":                       {T: "Abmelden"},
	"Order History":                  {T: "Auftragshistorie"},
	"load from file":                 {T: "von Datei laden"},
	"loaded from file":               {T: "von Datei geladen"},
	"defaults":                       {T: "Standardwerte"},
	"Wallet Password":                {T: "Wallet Passwort"},
	"w_password_helper":              {T: "Dies ist das Passwort das in der Walletsoftware konfiguriert wurde"},
	"w_password_tooltip":             {T: "Wenn für das Wallet kein Passwort erforderlich ist lass dieses Feld leer"},
	"App Password":                   {T: "App-Passwort"},
	"Add":                            {T: "Hinzufügen"},
	"Unlock":                         {T: "Entsperren"},
	"Rescan":                         {T: "Neu scannen"},
	"Wallet":                         {T: "Wallet"},
	"app_password_reminder":          {T: "Dein App-Passwort wird immer bei der Durchführung sensibler Walletoperationen benötigt."},
	"DEX Address":                    {T: "DEX Adresse"},
	"TLS Certificate":                {T: "TLS Zertifikat"},
	"remove":                         {T: "Entfernen"},
	"add a file":                     {T: "Datei hinzufügen"},
	"Submit":                         {T: "Senden"},
	"Confirm Registration":           {T: "Registration bestätigen"},
	"app_pw_reg":                     {T: "Gib dein App-Passwort ein um die DEX-Registrierung zu bestätigen."},
	"reg_confirm_submit":             {T: `Wenn du dieses Formular abschickst wird die Anmeldegebühr von deinem Geldbeutel abgebucht.`},
	"provided_markets":               {T: "Dieser DEX bietet folgende Märkte:"},
	"accepted_fee_assets":            {T: "Dieser DEX akzeptiert die folgenden Gebühren:"},
	"base_header":                    {T: "Basis"},
	"quote_header":                   {T: "Angebot"},
	"lot_size_headsup":               {T: "Alle Trades werden in Vielfachen der Lotgröße getätigt."},
	"Password":                       {T: "Passwort"},
	"Register":                       {T: "Registrieren"},
	"Authorize Export":               {T: "Export genehmigen"},
	"export_app_pw_msg":              {T: "Gib dein App-Passwort ein und genehmige den Kontoexport für"},
	"Disable Account":                {T: "Konto deaktivieren"},
	"disable_dex_server":             {T: "Dieser DEX-Server kann jederzeit wieder aktiviert werden, indem Du ihn erneut hinzufügst."},
	"Authorize Import":               {T: "Import genehmigen"},
	"app_pw_import_msg":              {T: "Gib dein App-Passwort ein um den Kontoimport zu bestätigen."},
	"Account File":                   {T: "Konto Datei"},
	"Change Application Password":    {T: "App-Passwort ändern"},
	"Current Password":               {T: "Aktuelles Passwort"},
	"New Password":                   {T: "Neues Passwort"},
	"Confirm New Password":           {T: "Neues Passwort bestätigen"},
	"cancel_no_pw":                   {T: "Sende einen Stornierungsauftrag für die verbleibenden"},
	"cancel_remain":                  {T: "Der verbleibende Betrag kann sich ändern bevor der Stornierungsauftrag ausgeführt wird."},
	"Log In":                         {T: "Anmelden"},
	"epoch":                          {T: "Epoche"},
	"price":                          {T: "Preis"},
	"volume":                         {T: "Volumen"},
	"buys":                           {T: "Käufe"},
	"sells":                          {T: "Verkäufe"},
	"Buy Orders":                     {T: "Kaufaufträge"},
	"Quantity":                       {T: "Menge"},
	"Rate":                           {T: "Kurs"},
	"Limit Order":                    {T: "Limit-Auftrag"},
	"Market Order":                   {T: "Markt-Auftrag"},
	"reg_status_msg":                 {T: `Um bei <span id="regStatusDex" class="text-break"></span> handeln zu können muss die Zahlung der Anmeldegebühr <span id="confReq"></span> bestätigt werden.`},
	"Buy":                            {T: "Kaufen"},
	"Sell":                           {T: "Verkaufen"},
	"lot_size":                       {T: "Lotgröße"},
	"Rate Step":                      {T: "Kurs Stufe"},
	"Max":                            {T: "Max"},
	"lot":                            {T: "Lot"},
	"min trade is about":             {T: "min trade ist ungefähr"},
	"Balances":                       {T: "Guthaben"},
	"outdated_tooltip":               {T: "Der Guthabenstand ist möglicherweise veraltet. Stell eine Verbindung zum Wallet her um ihn zu aktualisieren."},
	"available":                      {T: "verfügbar"},
	"connect_refresh_tooltip":        {T: "Zum Verbinden und Aktualisieren klicken"},
	"add_a_base_wallet":              {T: `Füge ein<br><span data-base-ticker></span><br>Wallet hinzu`},
	"add_a_quote_wallet":             {T: `Füge ein<br><span data-quote-ticker></span><br>Wallet hinzu`},
	"locked":                         {T: "gesperrt"},
	"immature":                       {T: "unfertig"},
	"Sell Orders":                    {T: "Verkaufsaufträge"},
	"Your Orders":                    {T: "Deine Aufträge"},
	"Type":                           {T: "Typ"},
	"Side":                           {T: "Seite"},
	"Age":                            {T: "Alter"},
	"Filled":                         {T: "Erfüllt"},
	"Settled":                        {T: "Abgewickelt"},
	"Status":                         {T: "Status"},
	"cancel_order":                   {T: "auftrag abbrechen"},
	"order details":                  {T: "Auftragsdetails"},
	"verify_order":                   {T: `Verifiziere Auftrag <span id="vSideHeader"></span>`},
	"You are submitting an order to": {T: "Du sendest ein Auftrag an"},
	"at a rate of":                   {T: "zu einer Rate von"},
	"for a total of":                 {T: "für eine Gesamtsumme von"},
	"verify_market":                  {T: "Es handelt sich hierbei um einen Marktauftrag der mit den besten verfügbaren Aufträgen im Buch gematcht wird. Auf der Grundlage des aktuellen Mid-Gap-Kurses auf dem Markt erhältst Du voraussichtlich etwa"},
	"auth_order_app_pw":              {T: "Autorisiere diesen Auftrat mit deinem App-Passwort."},
	"lots":                           {T: "Lots"},
	"order_disclaimer": {T: `<span class="red">WICHTIG</span>: Der Handel braucht Zeit zur Abwicklung und du darfst währenddessen den DEX Klient   
		oder die<span data-quote-ticker></span> oder <span data-base-ticker></span> Blockchain und/oder die Walletsoftware nicht schließen bis
		die Abwicklung abgeschlossen ist. Die Abwicklung kann innerhalb weniger Minuten abgeschlossen sein oder bis zu einigen Stunden dauern.`},
	"Order":                     {T: "Auftrag"},
	"see all orders":            {T: "Alle Aufträge anzeigen"},
	"Exchange":                  {T: "Exchange"},
	"Market":                    {T: "Markt"},
	"Offering":                  {T: "Angebot"},
	"Asking":                    {T: "Preisvorstellung"},
	"Fees":                      {T: "Gebühren"},
	"order_fees_tooltip":        {T: "On-Chain-Transaktionsgebühren die normalerweise vom Miner erhoben werden. Decred DEX verlangt keine Handelsgebühren."},
	"Matches":                   {T: "Matches"},
	"Match ID":                  {T: "Match ID"},
	"Time":                      {T: "Zeit"},
	"ago":                       {T: "zuvor"},
	"Cancellation":              {T: "Stornierung"},
	"Order Portion":             {T: "Auftragsanteil"},
	"you":                       {T: "Du"},
	"them":                      {T: "Gegenseite"},
	"Redemption":                {T: "Rücknahme"},
	"Refund":                    {T: "Erstattung"},
	"Funding Coins":             {T: "Funding-Coins"},
	"Exchanges":                 {T: "Exchanges"},
	"apply":                     {T: "Anwenden"},
	"Assets":                    {T: "Assets"},
	"Trade":                     {T: "Handeln"},
	"Set App Password":          {T: "App-Passwort festlegen"},
	"reg_set_app_pw_msg":        {T: "Vergebe dein App-Passwort. Dieses Passwort schützt deine DEX-Kontoschlüssel und die angeschlossenen Wallets."},
	"Password Again":            {T: "Passwort wiederholen"},
	"Add a DEX":                 {T: "Einen DEX hinzufügen"},
	"Pick a server":             {T: "Server auswählen"},
	"reg_ssl_needed":            {T: "Es sieht so aus als ob wir kein SSL-Zertifikat für diesen DEX haben. Füge das Zertifikat des Servers hinzu um fortzufahren."},
	"Dark Mode":                 {T: "Dark Mode"},
	"Show pop-up notifications": {T: "Popup-Benachrichtigungen anzeigen"},
	"Account ID":                {T: "Account ID"},
	"Export Account":            {T: "Account exportieren"},
	"simultaneous_servers_msg":  {T: "Der <span class=brand></span> unterstützt die gleichzeitige Nutzung einer beliebigen Anzahl von DEX-Servern."},
	"Change App Password":       {T: "App-Passwort ändern"},
	"Build ID":                  {T: "Build ID"},
	"Connect":                   {T: "Verbinden"},
	"Send":                      {T: "Senden"},
	"Deposit":                   {T: "Einzahlen"},
	"Lock":                      {T: "Sperren"},
	"New Deposit Address":       {T: "Neue Einzahlungsadresse"},
	"Address":                   {T: "Adresse"},
	"Amount":                    {T: "Betrag"},
	"Authorize the transfer with your app password.": {T: "Autorisiere die Transaktion mit deinem App-Passwort."},
	"Reconfigure":                 {T: "Rekonfigurieren"},
	"pw_change_instructions":      {T: "Das Ändern des Passworts ändert nicht das Passwort für deine Wallet-Software. Verwende dieses Formular um den DEX-Client zu aktualisieren nachdem du dein Passwort direkt in der Wallet-Software geändert hast."},
	"New Wallet Password":         {T: "Neues Wallet-Passwort"},
	"pw_change_warn":              {T: "Hinweis: Der Wechsel zu einer anderen Geldbörse während eines aktiven Handels kann zum Verlust von Guthaben führen."},
	"Show more options":           {T: "Weitere Optionen anzeigen"},
	"seed_implore_msg":            {T: "Du solltest deinen App-Seed sorgfältig notieren und eine Kopie davon speichern. Solltest du den Zugriff auf diesen Rechner oder die wichtigen Anwendungsdateien verlieren kann der Seed verwendet werden um deine DEX-Konten und nativen Wallets wiederherzustellen. Einige ältere Konten können nicht aus dem Seed wiederhergestellt werden. Unabhängig davon ob es sich um alte oder neue Konten handelt ist es eine empfehlenswerte Vorgehensweise die Kontoschlüssel getrennt vom Seed zu sichern."},
	"View Application Seed":       {T: "App-Seed anzeigen"},
	"Remember my password":        {T: "Passwort merken"},
	"pw_for_seed":                 {T: "Gib dein App-Passwort ein um deinen Seed anzuzeigen. Stelle sicher dass niemand sonst deinen Bildschirm sehen kann."},
	"Asset":                       {T: "Asset"},
	"Balance":                     {T: "Guthaben"},
	"Actions":                     {T: "Aktionen"},
	"Restoration Seed":            {T: "Wiederherstellungs-Seed"},
	"Restore from seed":           {T: "Aus Seed wiederherstellen"},
	"Import Account":              {T: "Account Importieren"},
	"no_wallet":                   {T: "kein Wallet"},
	"create_a_x_wallet":           {T: "Erstelle ein <span data-asset-name=1></span> Wallet"},
	"dont_share":                  {T: "Teile es nicht. Verliere es nicht."},
	"Show Me":                     {T: "Anzeigen"},
	"Wallet Settings":             {T: "Wallet Einstellungen"},
	"add_a_x_wallet":              {T: `Füge ein <img data-tmpl="assetLogo" class="small-icon mx-1"> <span data-tmpl="assetName"></span> Wallet hinzu`},
	"ready":                       {T: "fertig"},
	"off":                         {T: "Ausgeschaltet"},
	"Export Trades":               {T: "Exportiere Trades"},
	"change the wallet type":      {T: "den Wallet-Typ ändern"},
	"pick a different asset":      {T: "ein anderes Asset wählen"},
	"Create":                      {T: "Erstellen"},
	"1 Sync the Blockchain":       {T: "1: Blockchain synchronisieren"},
	"Progress":                    {T: "Fortschritt"},
	"remaining":                   {T: "verbleibend"},
	"2 Fund the Registration Fee": {T: "2: Die Anmeldegebühr bezahlen"},
	"One time anti-spam measure":  {T: "Dies ist eine kleine, einmalige Anti-Spam-Maßnahme um störendes Verhalten wie z.B. das Zurückziehen von Swaps zu verhindern."},
	"Registration fee":            {T: "Anmeldegebühr"},
	"Your Deposit Address":        {T: "Einzahlungsadresse für Ihr Wallet"},
	"Send enough with estimate":   {T: `Zahle mindestens <span data-tmpl="totalForBond"></span> <span class="unit">XYZ</span> ein um auch die Netzwerkgebühren der Transaktion zu decken. Du kannst so viel einzahlen wie du möchtest da nur der erforderliche Betrag im nächsten Schritt verrechnet wird. Du musst die Bestätigungen deiner Einzahlung abwarten damit du fortfahren kannst.`},
	"Send funds for token":        {T: `Zahle mindestens <span data-tmpl="tokenFees"></span> <span class="unit">XYZ</span> und <span data-tmpl="parentFees"></span> <span data-tmpl="parentUnit">XYZ</span> ein um die Registrationsgebühr zu begleichen. Du kannst soviel in dein Wallet einzahlen wie du möchtest da nur der genannte Betrag für die Zahlung der Registrationsgebühr genutzt wird. Die Einzahlung muss erst bestätigt werden damit du fortfahren kannst.`},
	"add a different server":      {T: "einen anderen Server hinzufügen"},
	"Add a custom server":         {T: "Benutzerdefinierten Server hinzufügen"},
	"plus tx fees":                {T: "+ tx fees"},
	"Export Seed":                 {T: "Seed exportieren"},
	"Total":                       {T: "Gesamt"},
	"Trading":                     {T: "Handeln"},
	"Receiving Approximately":     {T: "Empfange ungefähr"},
	"Fee Projection":              {T: "Gebührenprognose"},
	"details":                     {T: "Details"},
	"to":                          {T: "nach"},
	"Options":                     {T: "Optionen"},
	"fee_projection_tooltip":      {T: "Wenn sich die Netzwerkbedingungen nicht ändern bevor dein Auftrag erfüllt ist sollten die gesamten Gebühren innerhalb dieses Bereichs liegen."},
	"unlock_for_details":          {T: "Entsperre dein Wallet um Auftragsdetails und zusätzliche Optionen zu erhalten."},
	"estimate_unavailable":        {T: "Schätzungen und Optionen zum Auftrag nicht verfügbar"},
	"Fee Details":                 {T: "Gebühren Details"},
	"estimate_market_conditions":  {T: "Best- und Worst-Case-Schätzungen beruhen auf den aktuellen Netzwerkbedingungen und können sich bis zum Zeitpunkt der Auftragserfüllung ändern."},
	"Best Case Fees":              {T: "Best-Case Gebühren"},
	"best_case_conditions":        {T: "Die Best-Case Gebühren fallen an wenn der gesamte Auftrag in einem einzigen Matching durchgeführt wird."},
	"Swap":                        {T: "Swap"},
	"Redeem":                      {T: "Redeem"},
	"Worst Case Fees":             {T: "Worst-Case Gebühren"},
	"worst_case_conditions":       {T: "Der Worst-Case Fall kann eintreten wenn der Auftrag über viele Epochen hinweg in einzelnen Lots gematcht wird."},
	"Maximum Possible Swap Fees":  {T: "Höchstmögliche Swap-Gebühren"},
	"max_fee_conditions":          {T: "Dies ist der höchste Betrag der für deinen Swap fällig werden könnte. Normalerweise betragen die Gebühren nur einen Bruchteil dieses Satzes. Der Höchstbetrag kann nicht mehr geändert werden sobald der Auftrag erteilt ist."},
	"wallet_logs":                 {T: "Wallet Logs"},
	"accelerate_order":            {T: "Auftrag beschleunigen"},
	"acceleration_text":           {T: "Wenn deine Swap-Transaktionen stocken kannst du versuchen sie mit einer zusätzlichen Transaktion zu beschleunigen. Dies ist hilfreich wenn der Gebührensatz für eine bestehende unbestätigte Transaktion zu niedrig für das Mining im nächsten Block gewählt wurde, aber nicht wenn die Blöcke nur langsam gemined werden. Wenn du dieses Formular abschickst wird eine Transaktion erstellt die die Änderung aus deiner eigenen Swap-Initiierungstransaktion an dich selbst mit einer höheren Gebühr sendet. Der effektive Gebührensatz deiner Swap-Transaktionen wird zu dem Satz den du unten auswählst durchgeführt. Wähle einen Satz der ausreicht um in den nächsten Block aufgenommen zu werden. Ziehe einen Block-Explorer zu Rate um sicherzugehen."},
	"effective_swap_tx_rate":      {T: "Effektive Swap tx Gebühr"},
	"current_fee":                 {T: "Derzeitig empfohlene Gebühr"},
	"accelerate_success":          {T: `Erfolgreich übermittelte Transaktion: <span id="accelerateTxID"></span>`},
	"accelerate":                  {T: "Beschleunigen"},
	"acceleration_transactions":   {T: "Beschleunigungs-Transaktionen"},
	"acceleration_cost_msg":       {T: `Anhebung der effektiven Gebühr auf <span id="feeRateEstimate"></span> kostet <span id="feeEstimate"></span>`},
	"recent_acceleration_msg":     {T: `Ihre letzte Beschleunigung ist erst <span id="recentAccelerationTime"></span> Minuten her! Sind Sie sicher das Sie beschleunigen wollen?`},
	"recent_swap_msg":             {T: `Ihre älteste unbestätigte Swap-Transaktion wurde erst vor <span id="recentSwapTime"></span> Minuten eingereicht! Sind Sie sicher das Sie beschleunigen wollen?`},
	"early_acceleration_help_msg": {T: `Es schadet deinem Auftrag nicht, aber du verschwendest möglicherweise Geld. Die Beschleunigung ist nur dann hilfreich wenn der Gebührensatz für eine bestehende unbestätigte Transaktion zu niedrig gewählt wurde um im nächsten Block gemined zu werden aber nicht wenn die Blöcke nur langsam gemined werden. Du kannst dies im Block-Explorer bestätigen indem Du dieses Popup schließt und auf deine vorherigen Transaktionen klickst.`},
	"recover":                     {T: "Wiederherstellen"},
	"recover_wallet":              {T: "Wallet wiederherstellen"},
	"recover_warning":             {T: "Beim Wiederherstellen deines Wallet werden alle Wallet-Daten in einen Backup-Ordner verschoben. Du musst warten bis die Wallet wieder mit dem Netzwerk synchronisiert ist, was unter Umständen lange dauern kann bevor du die Wallet wieder benutzen kannst."},
	"wallet_actively_used":        {T: "Wallet wird aktiv genutzt!"},
	"confirm_force_message":       {T: "Dieses Wallet verwaltet aktiv Aufträge. Nachdem du diese Aktion durchgeführt hast wird es sehr lange dauern bis deine Wallet wieder synchronisiert ist was dazu führen kann das die laufenden Aufträge fehlschlagen. Führe diese Aktion nur durch wenn es absolut notwendig ist!"},
	"confirm":                     {T: "Bestätigen"},
	"cancel":                      {T: "Abbrechen"},
	"Update TLS Certificate":      {T: "TLS Zertifikat aktualisieren"},
	"registered dexes":            {T: "Registrierte Dexes:"},
	"successful_cert_update":      {T: "Zertifikat wurde erfolgreich aktualisiert!"},
	"update dex host":             {T: "DEX Host aktualisieren"},
	"copied":                      {T: "Kopiert!"},
	"export_wallet":               {T: "Wallet exportieren"},
	"pw_for_wallet_seed":          {T: "Gib dein App-Passwort ein um das Wallet-Seed anzuzeigen. Stelle sicher dass niemand sonst deinen Bildschirm sehen kann. Wenn jemand Zugriff auf den Wallet-Seed erhält kann er dein gesamtes Guthaben stehlen."},
	"export_wallet_disclaimer":    {T: `<span class="warning-text">Die Verwendung einer extern wiederhergestellten Wallet, während du aktive Trades im DEX laufen hast, kann zu fehlgeschlagenen Trades und VERLUST VON FINANZEN führen.</span> Es wird empfohlen das du deine Wallet nicht exportierst, es sei denn, du bist ein erfahrener Benutzer und weißt, was du tust.`},
	"export_wallet_msg":           {T: "Nachfolgend findest du die erforderlichen Seeds um dein Wallet in einigen der beliebten externen Wallets wiederherzustellen. Führe KEINE Transaktionen mit deinen externen Wallet durch während du aktive Trades auf dem DEX laufen hast."},
	"clipboard_warning":           {T: "Das Kopieren/Einfügen eines Wallet-Seeds stellt ein potenzielles Sicherheitsrisiko dar. Dies geschieht auf eigene Gefahr."},
	"fiat_exchange_rate_sources":  {T: "Quellen für den Fiat-Wechselkurs"},
	"Synchronizing":               {T: "Synchronisieren"},
	"wallet_wait_synced":          {T: "Das Wallet wird nach der Synchronisierung erstellt"},
	"Create a Wallet":             {T: "Ein Wallet erstellen"},
	"Receive":                     {T: "Empfangen"},
	"Wallet Type":                 {T: "Wallet Typ"},
	"Peer Count":                  {T: "Anzahl Peers"},
	"Sync Progress":               {T: "Sync-Fortschritt"},
	"Settings":                    {T: "Einstellungen"},
	"asset_name Markets":          {T: "<span data-asset-name=1></span> Märkte"},
	"Host":                        {T: "Host"},
	"No Recent Activity":          {T: "Keine aktuelle Aktivität"},
	"Recent asset_name Activity":  {T: "<span data-asset-name=1></span>Aktuelle Aktivitäten"},
	"other_actions":               {T: "Andere Aktionen"},
}
