export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export interface Database {
  public: {
    Tables: {
      commerces: {
        Row: {
          id: string;
          user_id: string;
          nom: string;
          adresse: string | null;
          telephone: string | null;
          email: string | null;
          logo_url: string | null;
          latitude: number | null;
          longitude: number | null;
          rayon_geo: number;
          actif: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['commerces']['Row'], 'id' | 'created_at' | 'updated_at'> & {
          id?: string;
          rayon_geo?: number;
          actif?: boolean;
        };
        Update: Partial<Database['public']['Tables']['commerces']['Insert']>;
      };
      cartes: {
        Row: {
          id: string;
          commerce_id: string;
          nom: string;
          description: string | null;
          type: 'points' | 'tampons';
          tampons_total: number;
          points_par_euro: number;
          points_recompense: number;
          recompense_description: string | null;
          couleur_fond: string;
          couleur_texte: string;
          couleur_accent: string;
          message_geo: string;
          logo_url: string | null;
          strip_url: string | null;
          strip_position: string | null;
          tampon_icon_url: string | null;
          barcode_type: string;
          label_client: string;
          couleur_fond_2: string | null;
          gradient_angle: number | null;
          pattern_type: string | null;
          tampon_emoji: string | null;
          police: string | null;
          police_taille: number | null;
          police_gras: boolean | null;
          texte_alignement: string | null;
          strip_plein_largeur: boolean | null;
          pass_type_id: string | null;
          qr_code_url: string | null;
          actif: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['cartes']['Row'], 'id' | 'created_at' | 'updated_at'> & {
          id?: string;
          tampons_total?: number;
          points_par_euro?: number;
          points_recompense?: number;
          couleur_fond?: string;
          couleur_texte?: string;
          couleur_accent?: string;
          message_geo?: string;
          actif?: boolean;
        };
        Update: Partial<Database['public']['Tables']['cartes']['Insert']>;
      };
      clients: {
        Row: {
          id: string;
          carte_id: string;
          commerce_id: string;
          nom: string | null;
          telephone: string | null;
          email: string | null;
          points_actuels: number;
          tampons_actuels: number;
          recompenses_obtenues: number;
          apple_pass_serial: string | null;
          google_pass_id: string | null;
          fcm_token: string | null;
          push_enabled: boolean;
          derniere_visite: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['clients']['Row'], 'id' | 'created_at' | 'updated_at'> & {
          id?: string;
          points_actuels?: number;
          tampons_actuels?: number;
          recompenses_obtenues?: number;
          push_enabled?: boolean;
        };
        Update: Partial<Database['public']['Tables']['clients']['Insert']>;
      };
      transactions: {
        Row: {
          id: string;
          client_id: string;
          commerce_id: string;
          type: 'ajout_points' | 'ajout_tampon' | 'recompense' | 'reset';
          valeur: number;
          points_avant: number | null;
          points_apres: number | null;
          note: string | null;
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['transactions']['Row'], 'id' | 'created_at'> & {
          id?: string;
        };
        Update: never;
      };
      notifications: {
        Row: {
          id: string;
          commerce_id: string;
          titre: string;
          message: string;
          type: string;
          nb_destinataires: number;
          nb_delivrees: number;
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['notifications']['Row'], 'id' | 'created_at'> & {
          id?: string;
          type?: string;
          nb_destinataires?: number;
          nb_delivrees?: number;
        };
        Update: Partial<Pick<Database['public']['Tables']['notifications']['Row'], 'nb_delivrees'>>;
      };
      apple_pass_registrations: {
        Row: {
          id: string;
          client_id: string;
          device_library_identifier: string;
          pass_type_identifier: string;
          push_token: string;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['apple_pass_registrations']['Row'], 'id' | 'created_at' | 'updated_at'> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['apple_pass_registrations']['Insert']>;
      };
    };
  };
}
