// Bot type identifier constants shared across the mmsettings subsystem.
//
// Lifted from vanilla `mmutil.ts` (L46-48). They are string-compared in
// wire data (`BotConfig.basicMarketMakingConfig` / `arbMarketMakingConfig`
// presence implicitly encodes these), but the mmsettings forms pass the
// explicit identifier through several components so it helps to have a
// single source of truth.

export const botTypeBasicMM = 'basicMM'
export const botTypeArbMM = 'arbMM'
export const botTypeBasicArb = 'basicArb'
