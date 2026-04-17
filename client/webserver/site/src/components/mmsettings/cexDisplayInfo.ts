// Shared CEX display metadata — logo + human-readable name keyed by
// the wire-level CEX identifier used across the MM subsystem
// (`CEXConfig.name`, `MMCEXStatus` keys, bot `cexName`).
//
// Previously duplicated in `pages/MMPage.tsx` and `pages/MMSettingsPage.tsx`
// (the stub); the mmsettings port will be a third consumer. Single
// source of truth avoids the three-way drift that happened in vanilla.

export interface CEXDisplayInfo {
  name: string
  logo: string
}

export const CEXDisplayInfos: Record<string, CEXDisplayInfo> = {
  Binance: { name: 'Binance', logo: '/img/binance.com.png' },
  BinanceUS: { name: 'Binance U.S.', logo: '/img/binance.us.png' },
  Bitget: { name: 'Bitget', logo: '/img/bitget.com.png' },
  Coinbase: { name: 'Coinbase', logo: '/img/coinbase.com.png' },
  MEXC: { name: 'MEXC', logo: '/img/mexc.com.png' }
}
