const contactDetails = {
  email: 'sales@figbloom.org',
  phone: '+254 796 286 676',
  whatsapp: '+254 798 941 392',
  location: 'Enterprise Road, SMK Business Centre',
};

export const phoneLink = `tel:${contactDetails.phone.replace(/\s/g, '')}`;
// wa.me only accepts digits, without "+" or spaces.
export const whatsappLink = `https://wa.me/${contactDetails.whatsapp.replace(/\D/g, '')}`;

// Phones can place calls; laptops can't.
export const isPhone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// Always compose in Gmail. A mailto: link would open the device's default
// mail app instead, which on Windows is usually Outlook.
export function emailLink(subject = '', body = '') {
  return `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(contactDetails.email)}`
    + `&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export default contactDetails;
