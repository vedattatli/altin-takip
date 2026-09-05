import type { Metadata } from "next";

import { Card, SectionTitle } from "@/components/ui";
import { requireUsableUser } from "@/server/auth";

export const metadata: Metadata = { title: "Gizlilik ve KVKK" };

/** Gizlilik ve KVKK bilgilendirmesi. */
export default async function PrivacyPage() {
  await requireUsableUser();
  return (
    <div className="space-y-5">
      <SectionTitle title="Gizlilik ve KVKK" />

      <Card className="space-y-4 p-4 text-sm leading-relaxed text-muted">
        <section>
          <h2 className="text-base font-semibold text-ink">Hangi verileri tutuyoruz?</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              Kullanıcı adınız ve ekranda görünen adınız; e-posta veya telefon numaranızı
              istemiyoruz.
            </li>
            <li>Parolanızı biz göremeyiz.</li>
            <li>Girdiğiniz alım ve satış kayıtları: miktar, tutar ve notlarınız.</li>
            <li>Giriş yaptığınız cihaz ve zaman bilgisi; IP adresiniz kaydedilmez.</li>
            <li>
              Yönetici hesabınızda ne yaptıysa kaydedilir; altın miktarınızı ve tutarlarınızı
              göremez.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-ink">Neden tutuyoruz?</h2>
          <p className="mt-2">
            Verileriniz yalnızca portföyünüzü göstermek ve hesabınızı korumak için kullanılır;
            reklam için kullanılmaz, kimseye satılmaz.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-ink">Saklama ve silme</h2>
          <p className="mt-2">
            Hesabınız durdukça verileriniz saklanır; Ayarlar ekranından silme talebi
            gönderdiğinizde yönetici onayıyla kalıcı olarak silinir, silmeden önce kayıtlarınızı CSV
            olarak indirebilirsiniz.
          </p>
        </section>
      </Card>
    </div>
  );
}
