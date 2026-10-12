/** The cart cookie, shared with the shopping assistant: it is not httpOnly because the page hands the id to the
 * widget (ACE.setCart) and adopts carts the widget creates. A cart id is a bearer token for the cart only. */
export const CART_COOKIE = "store_cart_id";
export const CART_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
