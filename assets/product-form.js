if (!customElements.get('product-form')) {
  customElements.define(
    'product-form',
    class ProductForm extends HTMLElement {
      constructor() {
        super();

        this.form = this.querySelector('form');
        this.variantIdInput.disabled = false;
        this.form.addEventListener('submit', this.onSubmitHandler.bind(this));
        this.cart = document.querySelector('cart-notification') || document.querySelector('cart-drawer');
        this.submitButton = this.querySelector('[type="submit"]');
        this.submitButtonText = this.submitButton.querySelector('span');

        if (document.querySelector('cart-drawer')) this.submitButton.setAttribute('aria-haspopup', 'dialog');

        this.hideErrors = this.dataset.hideErrors === 'true';
      }

      onSubmitHandler(evt) {
        evt.preventDefault();
        if (this.submitButton.getAttribute('aria-disabled') === 'true') return;

        this.handleErrorMessage();

        this.submitButton.setAttribute('aria-disabled', true);
        this.submitButton.classList.add('loading');
        this.querySelector('.loading__spinner').classList.remove('hidden');

        const config = fetchConfig('javascript');
        config.headers['X-Requested-With'] = 'XMLHttpRequest';
        delete config.headers['Content-Type'];

        const formData = new FormData(this.form);
        if (this.cart) {
          formData.append(
            'sections',
            this.cart.getSectionsToRender().map((section) => section.id)
          );
          formData.append('sections_url', window.location.pathname);
          this.cart.setActiveElement(document.activeElement);
        }
        config.body = formData;

        fetch(`${routes.cart_add_url}`, config)
          .then((response) => response.json())
          .then((response) => {
            if (response.status) {
              publish(PUB_SUB_EVENTS.cartError, {
                source: 'product-form',
                productVariantId: formData.get('id'),
                errors: response.errors || response.description,
                message: response.message,
              });
              this.handleErrorMessage(response.description);

              const soldOutMessage = this.submitButton.querySelector('.sold-out-message');
              if (!soldOutMessage) return;
              this.submitButton.setAttribute('aria-disabled', true);
              this.submitButtonText.classList.add('hidden');
              soldOutMessage.classList.remove('hidden');
              this.error = true;
              return;
            } else if (!this.cart) {
              window.location = window.routes.cart_url;
              return;
            }

            if (!this.error)
              publish(PUB_SUB_EVENTS.cartUpdate, {
                source: 'product-form',
                productVariantId: formData.get('id'),
                cartData: response,
              });
            this.error = false;
            const quickAddModal = this.closest('quick-add-modal');
            if (quickAddModal) {
              document.body.addEventListener(
                'modalClosed',
                () => {
                  setTimeout(() => {
                    this.cart.renderContents(response);
                  });
                },
                { once: true }
              );
              quickAddModal.hide(true);
            } else {
              this.cart.renderContents(response);
            }

            // Auto-add Soft Winter Jacket when added variant options are Black + Medium (site-wide)
            try {
              const addedVariantId = formData.get('id');
              // Fetch variant to inspect option1/option2/option3
              fetch(`/variants/${addedVariantId}.json`)
                .then((vRes) => vRes.ok ? vRes.json() : null)
                .then((variant) => {
                  if (!variant) return;
                  const norm = (v) => (v || '').toString().trim().toLowerCase();
                  const options = [variant.option1, variant.option2, variant.option3].map(norm);
                  const hasBlack = options.includes('black') || options.some((o) => o.startsWith('black'));
                  const sizeAliases = ['m', 'medium'];
                  const hasMedium = options.some((o) => sizeAliases.includes(o) || sizeAliases.some((s) => o.startsWith(s)));
                  if (!hasBlack || !hasMedium) return;

                  // Resolve gift variant id from window.GIFT_PRODUCT or fallback by handle
                  const getGiftVariantId = () => {
                    try {
                      const gp = (typeof window !== 'undefined' && window.GIFT_PRODUCT) ? window.GIFT_PRODUCT : null;
                      if (gp && gp.variantId) return Promise.resolve(gp.variantId);
                      const handle = gp && gp.handle ? gp.handle : 'soft-winter-jacket';
                      return fetch(`/products/${handle}.js`)
                        .then((r) => r.ok ? r.json() : null)
                        .then((p) => {
                          if (!p || !Array.isArray(p.variants) || p.variants.length === 0) return null;
                          const v = p.variants.find((vv) => vv.available) || p.variants[0];
                          return v ? v.id : null;
                        })
                        .catch(() => null);
                    } catch (_) {
                      return Promise.resolve(null);
                    }
                  };

                  const ensureNotAlreadyInCart = (giftId) => {
                    if (!giftId) return Promise.resolve(false);
                    return fetch('/cart.js')
                      .then((r) => r.ok ? r.json() : { items: [] })
                      .then((cart) => {
                        const exists = Array.isArray(cart.items) && cart.items.some((it) => it.id === giftId);
                        return !exists;
                      })
                      .catch(() => true);
                  };

                  getGiftVariantId().then((giftId) => {
                    if (!giftId) return;
                    ensureNotAlreadyInCart(giftId).then((shouldAdd) => {
                      if (!shouldAdd) return;
                      fetch('/cart/add.js', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          items: [
                            {
                              id: giftId,
                              quantity: 1,
                              properties: { 'Auto-added': 'Yes', 'Reason': 'Black + Medium variant selected' }
                            }
                          ]
                        })
                      })
                      .then(() => {
                        // Optionally, fetch and refresh the cart UI again
                        // We trigger another render by requesting cart sections
                        if (this.cart && this.cart.getSectionsToRender) {
                          fetch('/cart.js')
                            .then(() => {
                              // A second render without sections may not update Dawn drawer; leaving UI refresh to next interaction
                              // Intentionally minimal to avoid race conditions
                            })
                            .catch(() => {});
                        }
                      })
                      .catch(() => {});
                    });
                  });
                })
                .catch(() => {});
            } catch (_) {
              // no-op
            }
          })
          .catch((e) => {
            console.error(e);
          })
          .finally(() => {
            this.submitButton.classList.remove('loading');
            if (this.cart && this.cart.classList.contains('is-empty')) this.cart.classList.remove('is-empty');
            if (!this.error) this.submitButton.removeAttribute('aria-disabled');
            this.querySelector('.loading__spinner').classList.add('hidden');
          });
      }

      handleErrorMessage(errorMessage = false) {
        if (this.hideErrors) return;

        this.errorMessageWrapper =
          this.errorMessageWrapper || this.querySelector('.product-form__error-message-wrapper');
        if (!this.errorMessageWrapper) return;
        this.errorMessage = this.errorMessage || this.errorMessageWrapper.querySelector('.product-form__error-message');

        this.errorMessageWrapper.toggleAttribute('hidden', !errorMessage);

        if (errorMessage) {
          this.errorMessage.textContent = errorMessage;
        }
      }

      toggleSubmitButton(disable = true, text) {
        if (disable) {
          this.submitButton.setAttribute('disabled', 'disabled');
          if (text) this.submitButtonText.textContent = text;
        } else {
          this.submitButton.removeAttribute('disabled');
          this.submitButtonText.textContent = window.variantStrings.addToCart;
        }
      }

      get variantIdInput() {
        return this.form.querySelector('[name=id]');
      }
    }
  );
}
