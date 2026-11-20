/**
 * The shopper's marketplace app (docs/MARKETPLACE_PLAN.md). Mounted under
 * `/market` with wouter's `nest`, so every path inside is written relative to
 * it ("/stores", not "/market/stores") and the whole app can later move to the
 * root of its own host by changing one line in App.tsx.
 */
import { Route, Switch } from "wouter";
import { MarketShell } from "./MarketShell";
import { MarketHomePage } from "./pages/MarketHomePage";
import { MarketAccountPage, MarketCartPage, MarketCategoriesPage, MarketNotFoundPage, MarketSearchPage, MarketStoresPage } from "./pages/MarketPlaceholderPages";

export default function MarketApp() {
  return (
    <MarketShell>
      <Switch>
        <Route path="/" component={MarketHomePage} />
        <Route path="/stores" component={MarketStoresPage} />
        <Route path="/categories" component={MarketCategoriesPage} />
        <Route path="/cart" component={MarketCartPage} />
        <Route path="/account" component={MarketAccountPage} />
        <Route path="/search" component={MarketSearchPage} />
        <Route component={MarketNotFoundPage} />
      </Switch>
    </MarketShell>
  );
}
