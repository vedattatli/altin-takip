import type { Metadata } from "next";

import { appConfig } from "@/config/app.config";
import { Card, SectionTitle } from "@/components/ui";
import { requireUsableUser } from "@/server/auth";

export const metadata: Metadata = { title: "Gizlilik ve KVKK" };

/**
 * Gizlilik ve KVKK bilgilendirmesi (taslak).
 * Hukuki metin değildir; yayına almadan önce hukuki inceleme gerekir.
 */
export default async function PrivacyPage() {
  await requireUsableUser();
  return (
    <div className="space-y-5">
      <SectionTitle
        title="Gizlilik ve KVKK"
        description="Hangi veriyi neden tuttuğumuz, ne kadar süreyle sakladığımız ve haklarınız."
      />

      <Card className="space-y-4 p-4 text-sm leading-relaxed text-muted">
        <section>
          <h2 className="text-base font-semibold text-ink">Hangi verileri tutuyoruz?</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Kullanıcı adı, görünen ad ve rol. E-posta veya telefon toplanmaz.</li>
            <li>Parolanız yalnızca kimlik sağlayıcısında saklanır; uygulama parolanızı görmez.</li>
            <li>
              Uygulamaya kaydettiğiniz altın portföyü: işlem defteri, miktarlar, tutarlar ve notlarınız.
            </li>
            <li>Oturum kayıtları: cihaz etiketi ve zaman bilgisi. Ham IP adresi kaydedilmez.</li>
            <li>Yönetici erişimleri: hangi yöneticinin hangi kaydı ne zaman görüntülediği.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-ink">Neden tutuyoruz?</h2>
          <p className="mt-2">
            Portföyünüzü cihazlarınız arasında senkronize etmek, maliyet ve kâr/zarar hesabını yapmak
            ve hesabınızın güvenliğini sağlamak için. Verileriniz reklam veya profilleme amacıyla
            kullanılmaz, üçüncü taraflara satılmaz.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-ink">Fiyat verisi</h2>
          <p className="mt-2">
            Fiyatlar lisanslı veri sağlayıcılarından alınır ve bilgilendirme amaçlıdır.{" "}
            <strong className="text-ink">Bağlayıcı bir alım satım teklifi değildir.</strong> Lisanssız
            veya yapılandırılmamış kaynaklar kullanılmaz; test verisi her ekranda açıkça etiketlenir.
            {appConfig.name} vergi, muhasebe veya yatırım danışmanlığı hizmeti vermez.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-ink">Saklama ve silme</h2>
          <p className="mt-2">
            Hesabınız aktif olduğu sürece verileriniz saklanır. Ayarlar ekranından silme talebi
            gönderebilirsiniz; hesabınız ve portföy kayıtlarınız yönetici onayıyla kalıcı olarak
            silinir. Silmeden önce verilerinizi CSV olarak indirebilirsiniz. Finansal kayıtlar
            silinmez, iptal edilir veya düzeltilir; hesap silindiğinde ise bağlı tüm satırlar birlikte
            kaldırılır.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-ink">Haklarınız</h2>
          <p className="mt-2">
            Verilerinize erişme, düzeltme, dışa aktarma ve silinmesini talep etme haklarına sahipsiniz.
            Talepleriniz için uygulama yöneticinize başvurabilirsiniz.
          </p>
        </section>

        <p className="text-xs text-subtle">
          Bu metin bir taslaktır ve hukuki görüş yerine geçmez; yayına almadan önce hukuki inceleme yapılmalıdır.
        </p>
      </Card>
    </div>
  );
}
