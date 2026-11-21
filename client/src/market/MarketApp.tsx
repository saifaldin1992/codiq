/**
 * The shopper's marketplace app (docs/MARKETPLACE_PLAN.md). Mounted under
 * `/market` with wouter's `nest`, so every path inside is written relative to
 * it ("/stores", not "/market/stores") and the whole app can later move to the
 * root of its own host by changing one line in App.tsx.
 */
import { Route, Switch } from "wouter";
import { MarketShell } from "./MarketShell";
import { MarketHomePage } from "./pages/MarketHomePage";
import { MarketNotFoundPage } from "./pages/MarketNotFoundPage";
import { MarketCartPage } from "./pages/MarketCartPage";
import { MarketCheckoutPage } from "./pages/MarketCheckoutPage";
import { MarketOrderPage, MarketOrdersPage } from "./pages/MarketOrdersPages";
import { MarketAccountInfoPage, MarketAccountPage, MarketAddressesPage, MarketAddressFormPage } from "./pages/MarketAccountPages";
import { MarketCategoriesPage } from "./pages/MarketCategoriesPage";
import { MarketCategoryPage } from "./pages/MarketCategoryPage";
import { MarketSearchPage } from "./pages/MarketSearchPage";
import { MarketProductPage } from "./pages/MarketProductPage";
import { MarketCollectionPage, MarketMallPage, MarketSectionPage } from "./pages/MarketSectionPages";
import { MarketStoresPage } from "./pages/MarketStoresPage";
import { MarketStorePage } from "./pages/MarketStorePage";
import { MarketStoreReviewsPage } from "./pages/MarketStoreReviewsPage";
import { MarketStoreProductsPage } from "./pages/MarketStoreProductsPage";

export default function MarketApp() {
  return (
    <MarketShell>
      <Switch>
        <Route path="/" component={MarketHomePage} />
        <Route path="/stores" component={MarketStoresPage} />
        <Route path="/s/:slug/reviews" component={MarketStoreReviewsPage} />
        <Route path="/s/:slug/products" component={MarketStoreProductsPage} />
        <Route path="/s/:slug" component={MarketStorePage} />
        <Route path="/categories" component={MarketCategoriesPage} />
        <Route path="/c/:slug" component={MarketCategoryPage} />
        <Route path="/p/:id" component={MarketProductPage} />
        <Route path="/section/:key" component={MarketSectionPage} />
        <Route path="/collection/:slug" component={MarketCollectionPage} />
        <Route path="/mall/:slug" component={MarketMallPage} />
        <Route path="/cart" component={MarketCartPage} />
        <Route path="/checkout/:slug" component={MarketCheckoutPage} />
        <Route path="/orders" component={MarketOrdersPage} />
        <Route path="/orders/:id" component={MarketOrderPage} />
        <Route path="/account" component={MarketAccountPage} />
        <Route path="/account/info" component={MarketAccountInfoPage} />
        <Route path="/account/addresses" component={MarketAddressesPage} />
        <Route path="/account/addresses/:id" component={MarketAddressFormPage} />
        <Route path="/search" component={MarketSearchPage} />
        <Route component={MarketNotFoundPage} />
      </Switch>
    </MarketShell>
  );
}
